// ════════════════════════════════════════════════════════════════
// _lib.js — utilidades compartilhadas de autenticação (Bola de Cristal)
// Usado pelas Pages Functions /api/auth/* e /api/consent
// ════════════════════════════════════════════════════════════════

// ── Resposta JSON padrão ──
export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}

// ── Base64URL (sem padding) ──
function b64urlEncode(bytes) {
  let bin = '';
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ── HMAC-SHA256 assinatura de sessão (cookie assinado) ──
async function hmacKey(secret) {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

// Cria um token de sessão assinado: base64url(payload).base64url(assinatura)
export async function signSession(payload, secret) {
  const key = await hmacKey(secret);
  const body = b64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return body + '.' + b64urlEncode(sig);
}

// Verifica e decodifica um token de sessão. Retorna o payload ou null.
export async function verifySession(token, secret) {
  if (!token || token.indexOf('.') < 0) return null;
  const [body, sig] = token.split('.');
  try {
    const key = await hmacKey(secret);
    const ok = await crypto.subtle.verify(
      'HMAC', key, b64urlDecode(sig), new TextEncoder().encode(body)
    );
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body)));
    if (payload.exp && Date.now() > payload.exp) return null; // expirado
    return payload;
  } catch (_e) {
    return null;
  }
}

// ── Cookies ──
export function parseCookies(request) {
  const header = request.headers.get('Cookie') || '';
  const out = {};
  header.split(';').forEach((p) => {
    const idx = p.indexOf('=');
    if (idx > -1) out[p.slice(0, idx).trim()] = decodeURIComponent(p.slice(idx + 1).trim());
  });
  return out;
}

export function cookieHeader(name, value, maxAgeSec) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
  ];
  if (maxAgeSec === 0) parts.push('Max-Age=0');
  else if (maxAgeSec) parts.push(`Max-Age=${maxAgeSec}`);
  return parts.join('; ');
}

// ── State CSRF para o fluxo OAuth (assinado, curta duração) ──
export async function makeState(secret) {
  const nonce = b64urlEncode(crypto.getRandomValues(new Uint8Array(16)));
  const payload = { n: nonce, exp: Date.now() + 10 * 60 * 1000 };
  return signSession(payload, secret);
}
export async function checkState(state, secret) {
  const p = await verifySession(state, secret);
  return !!p;
}

// ── Random ID (para PK do registro de consent) ──
export function randomId() {
  return b64urlEncode(crypto.getRandomValues(new Uint8Array(16)));
}

const SESSION_COOKIE = 'bola_session';
export { SESSION_COOKIE };
