// ════════════════════════════════════════════════════════════════
// /api/auth/google — inicia o fluxo OAuth 2.0 com o Google
// Redireciona o usuário para a tela de consentimento do Google.
// ════════════════════════════════════════════════════════════════
import { makeState, cookieHeader } from './_lib.js';

export async function onRequestGet(context) {
  const { env, request } = context;

  if (!env.GOOGLE_CLIENT_ID || !env.SESSION_SECRET) {
    return new Response('Auth não configurada (faltam GOOGLE_CLIENT_ID / SESSION_SECRET).', { status: 500 });
  }

  const url = new URL(request.url);
  const origin = url.origin;
  const redirectUri = `${origin}/api/auth/callback`;

  // state CSRF assinado, guardado também em cookie p/ conferência no callback
  const state = await makeState(env.SESSION_SECRET);

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', 'openid email profile');
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('access_type', 'online');
  authUrl.searchParams.set('prompt', 'select_account');

  return new Response(null, {
    status: 302,
    headers: {
      Location: authUrl.toString(),
      'Set-Cookie': cookieHeader('bola_oauth_state', state, 600),
      'Cache-Control': 'no-store',
    },
  });
}
