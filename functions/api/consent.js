// ════════════════════════════════════════════════════════════════
// /api/consent — registra o ACEITE dos termos no banco D1 (auditoria).
// Grava: sub, nome, email, email_verified, timestamp, IP, user-agent,
// versão do termo e hash do termo aceito.
// ════════════════════════════════════════════════════════════════
import { json, parseCookies, verifySession, randomId, SESSION_COOKIE } from './auth/_lib.js';

export async function onRequestPost(context) {
  const { env, request } = context;

  // 1) Exige sessão válida
  const cookies = parseCookies(request);
  const session = await verifySession(cookies[SESSION_COOKIE], env.SESSION_SECRET || '');
  if (!session || !session.user) {
    return json({ error: 'unauthorized' }, 401);
  }
  const user = session.user;

  // 2) Lê o corpo (versão + hash do termo)
  let body;
  try {
    body = await request.json();
  } catch (_e) {
    return json({ error: 'bad_request' }, 400);
  }
  const termoVersao = String(body.termo_versao || '').slice(0, 200);
  const termoHash = String(body.termo_hash || '').slice(0, 128);
  const accepted = body.accepted === true;
  if (!accepted || !termoVersao || !termoHash) {
    return json({ error: 'missing_fields' }, 400);
  }

  // 3) Metadados de auditoria
  const ip =
    request.headers.get('CF-Connecting-IP') ||
    request.headers.get('X-Forwarded-For') ||
    '';
  const userAgent = (request.headers.get('User-Agent') || '').slice(0, 500);
  const acceptedAt = new Date().toISOString();
  const country = (request.cf && request.cf.country) || '';

  // 4) Persiste no D1
  if (!env.DB) {
    return json({ error: 'db_unavailable' }, 503);
  }
  try {
    await env.DB
      .prepare(
        `INSERT INTO consents
          (id, sub, name, email, email_verified, termo_versao, termo_hash,
           ip, user_agent, country, accepted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        randomId(),
        user.sub,
        user.name || '',
        user.email || '',
        user.email_verified ? 1 : 0,
        termoVersao,
        termoHash,
        ip,
        userAgent,
        country,
        acceptedAt
      )
      .run();
  } catch (e) {
    // não vaza detalhe interno ao cliente; registra só no log do servidor
    console.error('consent db_write_failed:', String(e).slice(0, 200));
    return json({ error: 'db_write_failed' }, 500);
  }

  return json({ ok: true, accepted_at: acceptedAt });
}
