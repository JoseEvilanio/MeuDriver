import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (request.method !== "POST") {
    return jsonResponse({ error: "Método não permitido." }, 405);
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const authorization = request.headers.get("Authorization");

    if (!supabaseUrl || !anonKey || !serviceRoleKey) {
      console.error("Supabase URL, anon key, or service role key is not configured.");
      return jsonResponse({ error: "A função de convite não está configurada no servidor." }, 500);
    }

    if (!authorization?.startsWith("Bearer ")) {
      return jsonResponse({ error: "Faça login para convidar usuários." }, 401);
    }

    const origin = request.headers.get("origin");
    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return jsonResponse({ error: "O corpo da solicitação não contém JSON válido." }, 400);
    }

    if (typeof payload !== "object" || payload === null || !("email" in payload) || !("redirectTo" in payload)) {
      return jsonResponse({ error: "Informe o e-mail e o endereço de retorno do convite." }, 400);
    }

    const { email, redirectTo } = payload;
    if (typeof email !== "string" || typeof redirectTo !== "string") {
      return jsonResponse({ error: "Os dados do convite são inválidos." }, 400);
    }

    const normalizedEmail = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      return jsonResponse({ error: "Informe um endereço de e-mail válido." }, 400);
    }

    let redirectUrl: URL;
    try {
      redirectUrl = new URL(redirectTo);
    } catch {
      return jsonResponse({ error: "O endereço de retorno do convite é inválido." }, 400);
    }

    if (
      !origin ||
      redirectUrl.origin !== origin ||
      redirectUrl.searchParams.get("invite") !== "accepted"
    ) {
      return jsonResponse({ error: "O endereço de retorno deve ser do mesmo site que enviou o convite." }, 400);
    }

    const callerClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: callerData, error: callerError } = await callerClient.auth.getUser();
    if (callerError || !callerData.user) {
      return jsonResponse({ error: "A sessão expirou. Entre novamente para continuar." }, 401);
    }

    const adminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: callerProfile, error: profileError } = await adminClient
      .from("user_profiles")
      .select("role")
      .eq("id", callerData.user.id)
      .maybeSingle();

    if (profileError) {
      console.error("Could not verify the caller's access role:", profileError.message);
      return jsonResponse({ error: "Não foi possível verificar seu nível de acesso." }, 500);
    }

    const isMaster = callerData.user.email?.toLowerCase() === "jose_evilanio@hotmail.com" ||
      callerProfile?.role === "master";
    if (!isMaster) {
      return jsonResponse({ error: "Somente usuários Master podem convidar colaboradores." }, 403);
    }

    if (normalizedEmail === "jose_evilanio@hotmail.com") {
      return jsonResponse({ error: "A conta Master já está configurada." }, 409);
    }

    const { data: existingProfile, error: existingProfileError } = await adminClient
      .from("user_profiles")
      .select("role")
      .eq("email", normalizedEmail)
      .maybeSingle();

    if (existingProfileError) {
      console.error("Could not check the invited user's profile:", existingProfileError.message);
      return jsonResponse({ error: "Não foi possível verificar o cadastro do e-mail informado." }, 500);
    }

    if (existingProfile?.role === "master") {
      return jsonResponse({ error: "Este e-mail já pertence a uma conta Master." }, 409);
    }

    const { data: inviteData, error: inviteError } = await adminClient.auth.admin.inviteUserByEmail(
      normalizedEmail,
      { redirectTo: redirectUrl.toString() },
    );

    if (inviteError) {
      console.error("Could not send the collaborator invitation:", inviteError.message);
      return jsonResponse({ error: inviteError.message }, inviteError.status || 400);
    }

    if (!inviteData.user) {
      return jsonResponse({ error: "O Supabase não retornou o usuário convidado." }, 502);
    }

    const { data: invitedProfile, error: invitedProfileError } = await adminClient
      .from("user_profiles")
      .select("id, email, role, created_at")
      .eq("id", inviteData.user.id)
      .single();

    if (invitedProfileError || !invitedProfile) {
      console.error("Invitation sent, but the collaborator profile could not be loaded:", invitedProfileError?.message);
      return jsonResponse({
        error: "O convite foi enviado, mas não foi possível confirmar o perfil. Atualize a lista antes de reenviar.",
      }, 500);
    }

    return jsonResponse({ user: invitedProfile }, 201);
  } catch (error) {
    console.error("Unexpected error while sending a collaborator invitation:", error);
    return jsonResponse({ error: "Ocorreu um erro inesperado ao enviar o convite." }, 500);
  }
});
