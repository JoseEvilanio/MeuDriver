import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const productionAppOrigin = "https://meu-driver.vercel.app";
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
      return jsonResponse({ error: "Faça login para administrar usuários." }, 401);
    }

    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return jsonResponse({ error: "O corpo da solicitação não contém JSON válido." }, 400);
    }

    if (typeof payload !== "object" || payload === null) {
      return jsonResponse({ error: "Os dados da solicitação são inválidos." }, 400);
    }

    const action = "action" in payload && typeof payload.action === "string"
      ? payload.action
      : "invite";
    if (action !== "invite" && action !== "set_role") {
      return jsonResponse({ error: "Ação de administração inválida." }, 400);
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
      return jsonResponse({ error: "Somente usuários Master podem administrar usuários e níveis." }, 403);
    }

    if (action === "set_role") {
      if (
        !("userId" in payload) ||
        typeof payload.userId !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(payload.userId) ||
        !("role" in payload) ||
        (payload.role !== "manager" && payload.role !== "collaborator")
      ) {
        return jsonResponse({ error: "Informe um usuário e o nível Colaborador ou Gerente." }, 400);
      }

      const { data: target, error: targetError } = await adminClient
        .from("user_profiles")
        .select("id, email, role")
        .eq("id", payload.userId)
        .maybeSingle();

      if (targetError) {
        console.error("Could not load the target user's profile:", targetError.message);
        return jsonResponse({ error: "Não foi possível verificar o usuário selecionado." }, 500);
      }
      if (!target) {
        return jsonResponse({ error: "O usuário selecionado não foi encontrado." }, 404);
      }
      if (target.role === "master" || target.email?.toLowerCase() === "jose_evilanio@hotmail.com") {
        return jsonResponse({ error: "O nível da conta Master não pode ser alterado." }, 403);
      }

      const { data: updatedUser, error: updateError } = await adminClient
        .from("user_profiles")
        .update({ role: payload.role })
        .eq("id", target.id)
        .select("id, email, role, created_at")
        .single();

      if (updateError || !updatedUser) {
        console.error("Could not update the user's access role:", updateError?.message);
        return jsonResponse({ error: "Não foi possível salvar o novo nível de acesso." }, 500);
      }

      return jsonResponse({ user: updatedUser });
    }

    if (!("email" in payload) || typeof payload.email !== "string") {
      return jsonResponse({ error: "Informe um e-mail válido para o convite." }, 400);
    }

    const normalizedEmail = payload.email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      return jsonResponse({ error: "Informe um endereço de e-mail válido." }, 400);
    }

    if (normalizedEmail === "jose_evilanio@hotmail.com") {
      return jsonResponse({ error: "A conta Master já está configurada." }, 409);
    }

    if (!("redirectTo" in payload) || typeof payload.redirectTo !== "string") {
      return jsonResponse({ error: "O endereço de retorno do convite é inválido." }, 400);
    }

    let redirectUrl: URL;
    try {
      redirectUrl = new URL(payload.redirectTo);
    } catch {
      return jsonResponse({ error: "O endereço de retorno do convite é inválido." }, 400);
    }

    if (
      redirectUrl.origin !== productionAppOrigin ||
      redirectUrl.pathname !== "/" ||
      redirectUrl.searchParams.get("invite") !== "accepted" ||
      [...redirectUrl.searchParams.keys()].some((key) => key !== "invite") ||
      redirectUrl.hash
    ) {
      return jsonResponse({ error: "O convite deve retornar ao endereço oficial do MeuDrive." }, 400);
    }

    const { data: existingProfile, error: existingProfileError } = await adminClient
      .from("user_profiles")
      .select("id, role")
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

    let invitedUserId = inviteData.user?.id ?? null;
    if (inviteError) {
      if (inviteError.status === 422 && existingProfile) {
        const { data: resendData, error: resendError } = await adminClient.auth.resend({
          type: "signup",
          email: normalizedEmail,
          options: { redirectTo: redirectUrl.toString() },
        });
        if (resendError) {
          console.error("Could not resend the collaborator invitation:", resendError.message);
          return jsonResponse({ error: resendError.message }, resendError.status || 400);
        }
        invitedUserId = resendData.user?.id ?? existingProfile.id;
      } else {
        console.error("Could not send the collaborator invitation:", inviteError.message);
        return jsonResponse({ error: inviteError.message }, inviteError.status || 400);
      }
    }

    if (!invitedUserId) {
      return jsonResponse({ error: "O Supabase não retornou o usuário convidado." }, 502);
    }

    const { data: invitedProfile, error: invitedProfileError } = await adminClient
      .from("user_profiles")
      .select("id, email, role, created_at")
      .eq("id", invitedUserId)
      .single();

    if (invitedProfileError || !invitedProfile) {
      console.error("Invitation sent, but the collaborator profile could not be loaded:", invitedProfileError?.message);
      return jsonResponse({
        error: "O convite foi enviado, mas não foi possível confirmar o perfil. Atualize a lista antes de reenviar.",
      }, 500);
    }

    return jsonResponse({ user: invitedProfile }, existingProfile ? 200 : 201);
  } catch (error) {
    console.error("Unexpected error while managing users:", error);
    return jsonResponse({ error: "Ocorreu um erro inesperado ao administrar usuários." }, 500);
  }
});
