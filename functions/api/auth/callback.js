// ════════════════════════════════════════════════════════════════
// /api/auth/callback — recebe o code do Google, troca por tokens,
// valida o id_token, cria a sessão (cookie assinado) e volta ao site.
// ════════════════════════════════════════════════════════════════
import {
  signSession, parseCookies, cookieHeader, verifySession, SESSION_COOKIE,
} from './_lib.js';

// Decodifica o payload do id_token (JWT) sem verificar assinatura.
// A confiança vem de obtê-lo via HTTPS direto do endpoint de token do Google.
function decodeJwtPayload(jwt) {
  try {
    const part = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(part + '==='.slice((part.length + 3) % 4));
    return JSON.parse(decodeURIComponent(escape(bin)));
  } catch (_e) {
    return null;
  }
}

export async function onRequestGet(context) {
  const { env, request } = context;
  const url = new URL(request.url);
  const origin = url.origin;

  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.SESSION_SECRET) {
    return new Response('Auth não configurada.', { status: 500 });
  }

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const cookies = parseCookies(request);

  // Confere o state CSRF (precisa bater com o cookie e ser válido/assinado)
  if (!code || !state || state !== cookies['bola_oauth_state']) {
    return redirectErr(origin, 'state_invalid');
  }
  const stateOk = await verifySession(state, env.SESSION_SECRET);
  if (!stateOk) return redirectErr(origin, 'state_expired');

  // Troca o code por tokens
  const redirectUri = `${origin}/api/auth/callback`;
  let tokenJson;
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });
    if (!tokenRes.ok) return redirectErr(origin, 'token_exchange_failed');
    tokenJson = await tokenRes.json();
  } catch (_e) {
    return redirectErr(origin, 'token_network');
  }

  const idToken = tokenJson.id_token;
  if (!idToken) return redirectErr(origin, 'no_id_token');

  const claims = decodeJwtPayload(idToken);
  if (!claims || !claims.sub) return redirectErr(origin, 'no_claims');

  // Confere se o token foi emitido para o nosso client_id
  if (claims.aud !== env.GOOGLE_CLIENT_ID) return redirectErr(origin, 'aud_mismatch');

  // Monta o usuário (identidade mínima necessária)
  const user = {
    sub: String(claims.sub),
    name: claims.name || '',
    email: claims.email || '',
    email_verified: !!claims.email_verified,
    picture: claims.picture || '',
  };

  // Cria a sessão (válida por 30 dias)
  const session = {
    user,
    iat: Date.now(),
    exp: Date.now() + 30 * 24 * 60 * 60 * 1000,
  };
  const token = await signSession(session, env.SESSION_SECRET);

  // Volta para o site com a aba bola aberta; limpa o cookie de state
  const headers = new Headers();
  headers.append('Location', `${origin}/?login=ok`);
  headers.append('Set-Cookie', cookieHeader(SESSION_COOKIE, token, 30 * 24 * 60 * 60));
  headers.append('Set-Cookie', cookieHeader('bola_oauth_state', '', 0));
  headers.append('Cache-Control', 'no-store');
  return new Response(null, { status: 302, headers });
}

function redirectErr(origin, reason) {
  return new Response(null, {
    status: 302,
    headers: { Location: `${origin}/?login_error=${encodeURIComponent(reason)}`, 'Cache-Control': 'no-store' },
  });
}
