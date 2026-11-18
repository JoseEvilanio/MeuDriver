import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
  GetObjectCommand,
  type CompletedPart,
} from "npm:@aws-sdk/client-s3@3.750.0";
import { getSignedUrl } from "npm:@aws-sdk/s3-request-presigner@3.750.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "600",
};
const defaultPartSize = 100 * 1024 * 1024;
const minimumPartSize = 5 * 1024 * 1024;
const maximumPartSize = 5 * 1024 * 1024 * 1024;
const maximumObjectSize = 5 * 1024 * 1024 * 1024 * 1024;
const maximumParts = 10_000;
const signedUrlLifetimeSeconds = 15 * 60;
const masterEmail = "jose_evilanio@hotmail.com";

class RequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

type UserIdentity = { id: string; email?: string };
type DriveFile = {
  id: string;
  user_id: string;
  original_name: string;
  original_path: string;
  storage_key: string;
  bucket_name: string;
  mime_type: string;
  file_size: number | string;
  upload_status: string;
  deleted_at: string | null;
  file_fingerprint: string | null;
};
type DriveUpload = {
  id: string;
  user_id: string;
  file_id: string;
  upload_id: string | null;
  storage_key: string;
  total_size: number | string;
  part_size: number | string;
  mime_type: string;
  file_fingerprint: string;
  status: string;
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function getUploadExpirationDate() {
  const configuredDays = Deno.env.get("R2_UPLOAD_EXPIRATION_DAYS");
  const days = configuredDays === undefined ? 30 : Number(configuredDays);
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    throw new Error("R2_UPLOAD_EXPIRATION_DAYS deve ser um inteiro entre 1 e 365.");
  }
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

function readR2Configuration() {
  const accountId = Deno.env.get("R2_ACCOUNT_ID");
  const accessKeyId = Deno.env.get("R2_ACCESS_KEY_ID");
  const secretAccessKey = Deno.env.get("R2_SECRET_ACCESS_KEY");
  const bucketName = Deno.env.get("R2_BUCKET_NAME");
  const endpoint = Deno.env.get("R2_ENDPOINT") || (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : "");

  if (!accountId || !accessKeyId || !secretAccessKey || !bucketName || !endpoint) {
    throw new Error("As credenciais e o bucket do Cloudflare R2 não estão configurados no servidor.");
  }

  return {
    bucketName,
    client: new S3Client({
      region: Deno.env.get("R2_REGION") || "auto",
      endpoint,
      forcePathStyle: true,
      credentials: { accessKeyId, secretAccessKey },
    }),
  };
}

function parseObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("O corpo da solicitação é inválido.");
  }
  return value as Record<string, unknown>;
}

function requireString(body: Record<string, unknown>, key: string, maximumLength = 4096) {
  const value = body[key];
  if (typeof value !== "string" || value.length === 0 || value.length > maximumLength) {
    throw new RequestError(`O campo "${key}" é inválido.`, 400);
  }
  return value;
}

function normalizeRelativePath(path: string) {
  const parts = path.replaceAll("\\", "/").split("/");
  if (
    parts.length === 0 ||
    parts.some((part) => !part || part === "." || part === ".." || part.includes("\0")) ||
    path.length > 1024
  ) {
    throw new RequestError("O caminho do arquivo é inválido.", 400);
  }
  return parts.join("/");
}

function getFileExtension(name: string) {
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : null;
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Ocorreu uma falha inesperada no armazenamento.";
}

async function listAllParts(client: S3Client, bucket: string, key: string, uploadId: string) {
  const parts: Array<{ PartNumber?: number; ETag?: string; Size?: number }> = [];
  let partNumberMarker: string | undefined;

  while (true) {
    const result = await client.send(new ListPartsCommand({
      Bucket: bucket,
      Key: key,
      UploadId: uploadId,
      PartNumberMarker: partNumberMarker,
    }));
    parts.push(...(result.Parts ?? []));
    if (!result.IsTruncated) {
      break;
    }
    if (!result.NextPartNumberMarker) {
      throw new Error("O R2 retornou uma paginação de partes inválida.");
    }
    partNumberMarker = String(result.NextPartNumberMarker);
  }

  return parts;
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (request.method !== "POST") {
    return jsonResponse({ error: "Método não permitido." }, 405);
  }

  try {
    const authorization = request.headers.get("Authorization");
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!authorization?.startsWith("Bearer ") || !supabaseUrl || !anonKey || !serviceRoleKey) {
      return jsonResponse({ error: "Faça login para acessar o armazenamento." }, 401);
    }

    let payload: Record<string, unknown>;
    try {
      payload = parseObject(await request.json());
    } catch (error) {
      return jsonResponse({ error: getErrorMessage(error) }, 400);
    }

    const callerClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: callerData, error: callerError } = await callerClient.auth.getUser();
    if (callerError || !callerData.user) {
      return jsonResponse({ error: "A sessão expirou. Entre novamente para continuar." }, 401);
    }
    const user: UserIdentity = { id: callerData.user.id, email: callerData.user.email };
    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: profile, error: profileError } = await admin
      .from("user_profiles")
      .select("role")
      .eq("id", user.id)
      .maybeSingle();
    if (profileError) {
      console.error("Could not verify the caller's role:", profileError.message);
      return jsonResponse({ error: "Não foi possível verificar seu nível de acesso." }, 500);
    }

    const canAccessAllFiles = user.email?.toLowerCase() === masterEmail ||
      profile?.role === "master" ||
      profile?.role === "manager";
    const action = requireString(payload, "action", 40);
    const { bucketName, client } = readR2Configuration();

    const authorizeFile = async (fileId: string) => {
      const { data, error } = await admin
        .from("drive_files")
        .select("id, user_id, original_name, original_path, storage_key, bucket_name, mime_type, file_size, upload_status, deleted_at, file_fingerprint")
        .eq("id", fileId)
        .maybeSingle();
      if (error) {
        throw new Error(`Não foi possível consultar o arquivo: ${error.message}`);
      }
      const file = data as DriveFile | null;
      if (!file || file.deleted_at || (!canAccessAllFiles && file.user_id !== user.id)) {
        throw new RequestError("Arquivo não encontrado ou sem permissão.", 404);
      }
      return file;
    };

    const authorizeUpload = async (uploadSessionId: string) => {
      const { data, error } = await admin
        .from("drive_uploads")
        .select("id, user_id, file_id, upload_id, storage_key, total_size, part_size, mime_type, file_fingerprint, status")
        .eq("id", uploadSessionId)
        .maybeSingle();
      if (error) {
        throw new Error(`Não foi possível consultar a sessão de upload: ${error.message}`);
      }
      const upload = data as DriveUpload | null;
      if (!upload || (!canAccessAllFiles && upload.user_id !== user.id) || upload.status !== "uploading") {
        throw new RequestError("Sessão de upload inexistente, expirada ou sem permissão.", 404);
      }
      return upload;
    };

    if (action === "upload-status") {
      const uploadSessionId = requireString(payload, "uploadSessionId", 80);
      const { data: upload, error } = await admin
        .from("drive_uploads")
        .select("id, user_id, file_id, storage_key, total_size, file_fingerprint, status")
        .eq("id", uploadSessionId)
        .maybeSingle();
      if (error) {
        throw new Error(`Não foi possível consultar o estado da sessão: ${error.message}`);
      }
      if (!upload || (!canAccessAllFiles && upload.user_id !== user.id)) {
        throw new RequestError("Sessão de upload inexistente ou sem permissão.", 404);
      }
      return jsonResponse({
        status: upload.status,
        fileId: upload.file_id,
        storageKey: upload.storage_key,
        totalSize: Number(upload.total_size),
        fingerprint: upload.file_fingerprint,
      });
    }

    if (action === "initiate") {
      const originalPath = normalizeRelativePath(requireString(payload, "originalPath"));
      const originalName = originalPath.split("/").pop()!;
      const size = payload.size;
      const requestedMimeType = typeof payload.mimeType === "string" && payload.mimeType.length <= 255
        ? payload.mimeType
        : "application/octet-stream";
      const mimeType = /^[\w.+-]+\/[\w.+-]+$/.test(requestedMimeType)
        ? requestedMimeType
        : "application/octet-stream";
      const fingerprint = requireString(payload, "fingerprint", 2048);
      const replaceFileId = typeof payload.replaceFileId === "string" ? payload.replaceFileId : null;
      if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0 || size > maximumObjectSize) {
        return jsonResponse({ error: "O tamanho do arquivo está fora do limite suportado pelo R2." }, 400);
      }
      const requestedPartSize = typeof payload.partSize === "number" &&
        Number.isSafeInteger(payload.partSize) &&
        payload.partSize >= minimumPartSize &&
        payload.partSize <= maximumPartSize
        ? payload.partSize
        : defaultPartSize;
      const requiredPartSize = Math.ceil(size / maximumParts);
      const partSize = Math.max(requestedPartSize, Math.ceil(requiredPartSize / (1024 * 1024)) * 1024 * 1024);
      if (Math.ceil(size / partSize) > maximumParts) {
        return jsonResponse({ error: "O tamanho e a divisão escolhida excedem o limite de partes multipart." }, 400);
      }

      let existingFile: DriveFile | null = null;
      if (replaceFileId) {
        existingFile = await authorizeFile(replaceFileId);
        if (existingFile.user_id !== user.id && !canAccessAllFiles) {
          return jsonResponse({ error: "Você não pode substituir este arquivo." }, 403);
        }
        if (existingFile.original_path !== originalPath) {
          return jsonResponse({ error: "A substituição deve manter o caminho original do arquivo." }, 400);
        }
      } else {
        const { data: conflict, error: conflictError } = await admin
          .from("drive_files")
          .select("id, storage_key, file_fingerprint, upload_status")
          .eq("user_id", user.id)
          .eq("original_path", originalPath)
          .is("deleted_at", null)
          .maybeSingle();
        if (conflictError) {
          throw new Error(`Não foi possível verificar o caminho do arquivo: ${conflictError.message}`);
        }
        if (
          conflict &&
          conflict.upload_status === "uploading" &&
          conflict.file_fingerprint === fingerprint
        ) {
          const { data: existingUpload, error: existingUploadError } = await admin
            .from("drive_uploads")
            .select("id, upload_id, storage_key, total_size, part_size, mime_type, file_fingerprint")
            .eq("file_id", conflict.id)
            .eq("status", "uploading")
            .gt("expires_at", new Date().toISOString())
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          if (existingUploadError) {
            throw new Error(`Não foi possível recuperar a sessão multipart: ${existingUploadError.message}`);
          }
          if (existingUpload) {
            const existingUrl = existingUpload.upload_id
              ? null
              : await getSignedUrl(client, new PutObjectCommand({
                Bucket: bucketName,
                Key: existingUpload.storage_key,
                ContentType: existingUpload.mime_type,
              }), { expiresIn: signedUrlLifetimeSeconds });
            return jsonResponse({
              uploadSessionId: existingUpload.id,
              fileId: conflict.id,
              storageKey: existingUpload.storage_key,
              uploadId: existingUpload.upload_id,
              partSize: Number(existingUpload.part_size),
              partCount: Math.ceil(Number(existingUpload.total_size) / Number(existingUpload.part_size)),
              mode: existingUpload.upload_id ? "multipart" : "single",
              url: existingUrl,
              fingerprint,
            });
          }
        }
        if (conflict) {
          return jsonResponse({ error: "Já existe um arquivo com este caminho. Renomeie-o ou use a substituição explícita." }, 409);
        }
      }

      const storageKey = `${user.id}/${crypto.randomUUID()}`;
      const fileId = existingFile?.id ?? crypto.randomUUID();
      if (!existingFile) {
        const { error } = await admin.from("drive_files").insert({
          id: fileId,
          user_id: user.id,
          original_name: originalName,
          original_path: originalPath,
          storage_key: storageKey,
          bucket_name: bucketName,
          mime_type: mimeType,
          file_extension: getFileExtension(originalName),
          file_size: size,
          storage_provider: "cloudflare_r2",
          upload_status: "uploading",
          file_fingerprint: fingerprint,
        });
        if (error) {
          throw new Error(`Não foi possível registrar o arquivo: ${error.message}`);
        }
      }

      let uploadId: string | null = null;
      let url: string | null = null;
      try {
        if (size === 0) {
          url = await getSignedUrl(client, new PutObjectCommand({
            Bucket: bucketName,
            Key: storageKey,
            ContentType: mimeType,
          }), { expiresIn: signedUrlLifetimeSeconds });
        } else {
          const created = await client.send(new CreateMultipartUploadCommand({
            Bucket: bucketName,
            Key: storageKey,
            ContentType: mimeType,
          }));
          if (!created.UploadId) {
            throw new Error("O R2 não retornou o identificador do upload multipart.");
          }
          uploadId = created.UploadId;
        }

        const { data: upload, error: uploadError } = await admin
          .from("drive_uploads")
          .insert({
            user_id: user.id,
            file_id: fileId,
            upload_id: uploadId,
            storage_key: storageKey,
            total_size: size,
            part_size: partSize,
            mime_type: mimeType,
            file_fingerprint: fingerprint,
            expires_at: getUploadExpirationDate(),
            status: "uploading",
          })
          .select("id")
          .single();
        if (uploadError || !upload) {
          throw new Error(`Não foi possível salvar a sessão multipart: ${uploadError?.message ?? "registro ausente."}`);
        }

        return jsonResponse({
          uploadSessionId: upload.id,
          fileId,
          storageKey,
          uploadId,
          partSize,
          partCount: Math.ceil(size / partSize),
          mode: size === 0 ? "single" : "multipart",
          url,
          fingerprint,
        }, 201);
      } catch (error) {
        if (uploadId) {
          await client.send(new AbortMultipartUploadCommand({ Bucket: bucketName, Key: storageKey, UploadId: uploadId }));
        } else if (url) {
          await client.send(new DeleteObjectCommand({ Bucket: bucketName, Key: storageKey }));
        }
        if (!existingFile) {
          const { error: deleteFileError } = await admin.from("drive_files").delete().eq("id", fileId);
          if (deleteFileError) {
            console.error("Could not remove the incomplete file catalog row:", deleteFileError.message);
          }
        }
        throw error;
      }
    }

    if (action === "list-parts") {
      const upload = await authorizeUpload(requireString(payload, "uploadSessionId", 80));
      const parts = upload.upload_id
        ? await listAllParts(client, bucketName, upload.storage_key, upload.upload_id)
        : [];
      const completedParts = parts
        .map((part) => part.PartNumber)
        .filter((partNumber): partNumber is number => typeof partNumber === "number");
      const { error: partsError } = await admin.from("drive_uploads").update({
        completed_parts: completedParts,
        updated_at: new Date().toISOString(),
      }).eq("id", upload.id);
      if (partsError) {
        throw new Error(`Não foi possível registrar as partes confirmadas: ${partsError.message}`);
      }
      return jsonResponse({
        uploadSessionId: upload.id,
        fileId: upload.file_id,
        storageKey: upload.storage_key,
        uploadId: upload.upload_id,
        totalSize: Number(upload.total_size),
        partSize: Number(upload.part_size),
        fingerprint: upload.file_fingerprint,
        parts: parts.map((part) => ({
          partNumber: part.PartNumber,
          etag: part.ETag,
          size: part.Size,
        })),
      });
    }

    if (action === "part-urls") {
      const upload = await authorizeUpload(requireString(payload, "uploadSessionId", 80));
      if (!upload.upload_id || !Array.isArray(payload.partNumbers) || payload.partNumbers.length > 100) {
        return jsonResponse({ error: "A solicitação de URLs para partes é inválida." }, 400);
      }
      const partCount = Math.ceil(Number(upload.total_size) / Number(upload.part_size));
      const partNumbers = [...new Set(payload.partNumbers)].filter((value): value is number =>
        typeof value === "number" &&
        Number.isInteger(value) &&
        value >= 1 &&
        value <= partCount,
      );
      if (partNumbers.length !== payload.partNumbers.length) {
        return jsonResponse({ error: "Um ou mais números de parte estão fora do intervalo permitido." }, 400);
      }
      const urls = await Promise.all(partNumbers.map(async (partNumber) => ({
        partNumber,
        url: await getSignedUrl(client, new UploadPartCommand({
          Bucket: bucketName,
          Key: upload.storage_key,
          UploadId: upload.upload_id!,
          PartNumber: partNumber,
        }), { expiresIn: signedUrlLifetimeSeconds }),
      })));
      return jsonResponse({ urls });
    }

    if (action === "single-url") {
      const upload = await authorizeUpload(requireString(payload, "uploadSessionId", 80));
      if (upload.upload_id || Number(upload.total_size) !== 0) {
        return jsonResponse({ error: "Esta sessão não aceita um upload simples." }, 400);
      }
      const url = await getSignedUrl(client, new PutObjectCommand({
        Bucket: bucketName,
        Key: upload.storage_key,
        ContentType: upload.mime_type,
      }), { expiresIn: signedUrlLifetimeSeconds });
      return jsonResponse({ url });
    }

    if (action === "complete") {
      const upload = await authorizeUpload(requireString(payload, "uploadSessionId", 80));
      if (!upload.upload_id) {
        return jsonResponse({ error: "Esta sessão não é multipart." }, 400);
      }
      const expectedPartCount = Math.ceil(Number(upload.total_size) / Number(upload.part_size));
      const parts = await listAllParts(client, bucketName, upload.storage_key, upload.upload_id);
      const byNumber = new Map(parts.map((part) => [part.PartNumber, part]));
      if (
        parts.length !== expectedPartCount ||
        Array.from({ length: expectedPartCount }, (_, index) => index + 1).some((number) =>
          !byNumber.has(number) || !byNumber.get(number)?.ETag
        )
      ) {
        return jsonResponse({ error: "O R2 ainda não recebeu todas as partes. O upload não foi finalizado." }, 409);
      }

      const completedParts: CompletedPart[] = Array.from({ length: expectedPartCount }, (_, index) => {
        const part = byNumber.get(index + 1)!;
        return { PartNumber: index + 1, ETag: part.ETag };
      });
      await client.send(new CompleteMultipartUploadCommand({
        Bucket: bucketName,
        Key: upload.storage_key,
        UploadId: upload.upload_id,
        MultipartUpload: { Parts: completedParts },
      }));
      const head = await client.send(new HeadObjectCommand({ Bucket: bucketName, Key: upload.storage_key }));
      if (Number(head.ContentLength) !== Number(upload.total_size)) {
        return jsonResponse({ error: "O tamanho confirmado pelo R2 não corresponde ao arquivo original. A reconciliação é necessária." }, 502);
      }

      const { data: fileData, error: fileError } = await admin
        .from("drive_files")
        .select("id, storage_key, user_id")
        .eq("id", upload.file_id)
        .single();
      if (fileError || !fileData) {
        console.error("R2 upload completed but file metadata could not be loaded:", fileError?.message);
        return jsonResponse({ error: "O objeto foi concluído no R2, mas o catálogo não foi atualizado. Use a reconciliação da sessão." }, 500);
      }

      const { error: updateFileError } = await admin
        .from("drive_files")
        .update({
          storage_key: upload.storage_key,
          bucket_name: bucketName,
          file_size: Number(head.ContentLength),
          etag: head.ETag ?? null,
          mime_type: upload.mime_type,
          file_fingerprint: upload.file_fingerprint,
          upload_status: "completed",
          updated_at: new Date().toISOString(),
        })
        .eq("id", upload.file_id);
      if (updateFileError) {
        console.error("R2 upload completed but metadata update failed:", updateFileError.message);
        return jsonResponse({ error: "O objeto foi concluído no R2, mas o catálogo não foi atualizado. Use a reconciliação da sessão." }, 500);
      }

      const { error: updateUploadError } = await admin
        .from("drive_uploads")
        .update({ status: "completed", updated_at: new Date().toISOString() })
        .eq("id", upload.id);
      if (updateUploadError) {
        console.error("File metadata updated but upload session status update failed:", updateUploadError.message);
        return jsonResponse({ error: "O objeto foi concluído e o catálogo foi atualizado, mas o estado da sessão não foi salvo. Tente reconciliar." }, 500);
      }

      if (fileData.storage_key !== upload.storage_key) {
        try {
          await client.send(new DeleteObjectCommand({ Bucket: bucketName, Key: fileData.storage_key }));
        } catch (error) {
          console.error("Replacement succeeded but the previous R2 object could not be removed:", getErrorMessage(error));
        }
      }
      return jsonResponse({ fileId: upload.file_id, size: Number(head.ContentLength), etag: head.ETag ?? null });
    }

    if (action === "finalize-single") {
      const upload = await authorizeUpload(requireString(payload, "uploadSessionId", 80));
      if (upload.upload_id || Number(upload.total_size) !== 0) {
        return jsonResponse({ error: "A sessão não é um upload simples vazio." }, 400);
      }
      const head = await client.send(new HeadObjectCommand({ Bucket: bucketName, Key: upload.storage_key }));
      if (Number(head.ContentLength) !== 0) {
        return jsonResponse({ error: "O objeto vazio não passou na validação de tamanho." }, 409);
      }
      const { data: previousFile, error: previousFileError } = await admin
        .from("drive_files")
        .select("storage_key")
        .eq("id", upload.file_id)
        .single();
      if (previousFileError || !previousFile) {
        return jsonResponse({ error: "O objeto foi criado no R2, mas o registro anterior não pôde ser recuperado para finalizar." }, 500);
      }
      const { error } = await admin.from("drive_files").update({
        storage_key: upload.storage_key,
        bucket_name: bucketName,
        file_size: 0,
        upload_status: "completed",
        etag: head.ETag ?? null,
        mime_type: upload.mime_type,
        file_fingerprint: upload.file_fingerprint,
        updated_at: new Date().toISOString(),
      }).eq("id", upload.file_id);
      if (error) {
        console.error("Empty R2 upload completed but metadata update failed:", error.message);
        return jsonResponse({ error: "O objeto foi criado no R2, mas o catálogo não foi atualizado. Tente reconciliar." }, 500);
      }
      const { error: sessionError } = await admin.from("drive_uploads")
        .update({ status: "completed", updated_at: new Date().toISOString() })
        .eq("id", upload.id);
      if (sessionError) {
        console.error("Empty R2 upload completed but the session status could not be updated:", sessionError.message);
        return jsonResponse({ error: "O objeto foi concluído no R2, mas a sessão não foi atualizada. Tente reconciliar." }, 500);
      }
      if (previousFile.storage_key !== upload.storage_key) {
        try {
          await client.send(new DeleteObjectCommand({ Bucket: bucketName, Key: previousFile.storage_key }));
        } catch (error) {
          console.error("Empty-file replacement succeeded but the previous object could not be removed:", getErrorMessage(error));
        }
      }
      return jsonResponse({ fileId: upload.file_id, size: 0, etag: head.ETag ?? null });
    }

    if (action === "reconcile") {
      const upload = await authorizeUpload(requireString(payload, "uploadSessionId", 80));
      const head = await client.send(new HeadObjectCommand({ Bucket: bucketName, Key: upload.storage_key }));
      if (Number(head.ContentLength) !== Number(upload.total_size)) {
        return jsonResponse({ error: "O objeto não existe ou o tamanho não corresponde à sessão." }, 409);
      }
      const { error } = await admin.from("drive_files").update({
        storage_key: upload.storage_key,
        bucket_name: bucketName,
        file_size: Number(head.ContentLength),
        upload_status: "completed",
        etag: head.ETag ?? null,
        mime_type: upload.mime_type,
        file_fingerprint: upload.file_fingerprint,
        updated_at: new Date().toISOString(),
      }).eq("id", upload.file_id);
      if (error) {
        throw new Error(`Não foi possível reconciliar os metadados: ${error.message}`);
      }
      const { error: sessionError } = await admin.from("drive_uploads")
        .update({ status: "completed", updated_at: new Date().toISOString() })
        .eq("id", upload.id);
      if (sessionError) {
        throw new Error(`Os metadados foram reconciliados, mas a sessão não foi atualizada: ${sessionError.message}`);
      }
      return jsonResponse({ fileId: upload.file_id, size: Number(head.ContentLength), etag: head.ETag ?? null });
    }

    if (action === "download-url") {
      const file = await authorizeFile(requireString(payload, "fileId", 80));
      if (file.upload_status !== "completed") {
        return jsonResponse({ error: "O arquivo ainda não foi concluído." }, 409);
      }
      const disposition = payload.inline === true ? "inline" : "attachment";
      const url = await getSignedUrl(client, new GetObjectCommand({
        Bucket: file.bucket_name,
        Key: file.storage_key,
        ResponseContentType: file.mime_type,
        ResponseContentDisposition: `${disposition}; filename*=UTF-8''${encodeURIComponent(file.original_name)}`,
      }), { expiresIn: signedUrlLifetimeSeconds });
      return jsonResponse({ url, expiresIn: signedUrlLifetimeSeconds });
    }

    if (action === "delete-file") {
      const file = await authorizeFile(requireString(payload, "fileId", 80));
      if (file.upload_status !== "completed") {
        return jsonResponse({ error: "Somente arquivos concluídos podem ser excluídos." }, 409);
      }
      await client.send(new DeleteObjectCommand({ Bucket: file.bucket_name, Key: file.storage_key }));
      const { error } = await admin.from("drive_files").update({
        deleted_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq("id", file.id);
      if (error) {
        console.error("R2 object deleted but metadata could not be marked deleted:", error.message);
        return jsonResponse({ error: "O objeto foi removido do R2, mas o catálogo não foi atualizado. Atualize os dados para reconciliar." }, 500);
      }
      return jsonResponse({ deleted: true });
    }

    if (action === "rename-file" || action === "move-file") {
      const file = await authorizeFile(requireString(payload, "fileId", 80));
      if (file.upload_status !== "completed") {
        return jsonResponse({ error: "Somente arquivos concluídos podem ser renomeados ou movidos." }, 409);
      }
      const requestedPath = normalizeRelativePath(requireString(payload, "originalPath"));
      const { error } = await admin.from("drive_files").update({
        original_path: requestedPath,
        original_name: requestedPath.split("/").pop(),
        file_extension: getFileExtension(requestedPath.split("/").pop()!),
        updated_at: new Date().toISOString(),
      }).eq("id", file.id);
      if (error) {
        return jsonResponse({ error: `Não foi possível atualizar o nome ou caminho: ${error.message}` }, 409);
      }
      return jsonResponse({ updated: true, originalPath: requestedPath });
    }

    if (action === "cancel") {
      const upload = await authorizeUpload(requireString(payload, "uploadSessionId", 80));
      if (upload.upload_id) {
        await client.send(new AbortMultipartUploadCommand({
          Bucket: bucketName,
          Key: upload.storage_key,
          UploadId: upload.upload_id,
        }));
      } else {
        await client.send(new DeleteObjectCommand({ Bucket: bucketName, Key: upload.storage_key }));
      }
      const { error: cancelUploadError } = await admin.from("drive_uploads")
        .update({ status: "cancelled", updated_at: new Date().toISOString() })
        .eq("id", upload.id);
      if (cancelUploadError) {
        throw new Error(`O R2 cancelou o upload, mas o estado da sessão não foi atualizado: ${cancelUploadError.message}`);
      }
      const { data: file, error: fileError } = await admin.from("drive_files")
        .select("storage_key")
        .eq("id", upload.file_id)
        .maybeSingle();
      if (fileError) {
        throw new Error(`O R2 cancelou o upload, mas não foi possível verificar o arquivo: ${fileError.message}`);
      }
      if (file?.storage_key === upload.storage_key) {
        const { error: updateFileError } = await admin.from("drive_files").update({
          upload_status: "cancelled",
          deleted_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).eq("id", upload.file_id);
        if (updateFileError) {
          throw new Error(`O R2 cancelou o upload, mas o arquivo não foi marcado como cancelado: ${updateFileError.message}`);
        }
      }
      return jsonResponse({ cancelled: true });
    }

    if (action === "cleanup-expired") {
      if (!canAccessAllFiles) {
        return jsonResponse({ error: "Somente um gerente ou Master pode iniciar a limpeza." }, 403);
      }
      const { data: expired, error } = await admin
        .from("drive_uploads")
        .select("id, user_id, file_id, upload_id, storage_key, total_size, part_size, mime_type, file_fingerprint, status")
        .eq("status", "uploading")
        .lt("expires_at", new Date().toISOString())
        .limit(100);
      if (error) {
        throw new Error(`Não foi possível localizar uploads expirados: ${error.message}`);
      }
      let cleaned = 0;
      for (const candidate of (expired ?? []) as DriveUpload[]) {
        if (candidate.upload_id) {
          await client.send(new AbortMultipartUploadCommand({
            Bucket: bucketName,
            Key: candidate.storage_key,
            UploadId: candidate.upload_id,
          }));
        } else {
          await client.send(new DeleteObjectCommand({ Bucket: bucketName, Key: candidate.storage_key }));
        }
        const { error: uploadUpdateError } = await admin.from("drive_uploads")
          .update({ status: "cancelled", updated_at: new Date().toISOString() })
          .eq("id", candidate.id);
        if (uploadUpdateError) {
          throw new Error(`Não foi possível marcar como cancelada a sessão expirada ${candidate.id}: ${uploadUpdateError.message}`);
        }
        const { error: fileUpdateError } = await admin.from("drive_files").update({
          upload_status: "cancelled",
          deleted_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).eq("id", candidate.file_id).eq("storage_key", candidate.storage_key);
        if (fileUpdateError) {
          throw new Error(`Não foi possível atualizar o catálogo do upload expirado ${candidate.id}: ${fileUpdateError.message}`);
        }
        cleaned += 1;
      }
      return jsonResponse({ cleaned });
    }

    return jsonResponse({ error: "Ação de armazenamento inválida." }, 400);
  } catch (error) {
    console.error("Cloudflare storage request failed:", error);
    return jsonResponse({
      error: getErrorMessage(error),
    }, error instanceof RequestError ? error.status : 500);
  }
});
