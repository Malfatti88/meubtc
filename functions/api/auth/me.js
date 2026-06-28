// ════════════════════════════════════════════════════════════════
// /api/auth/me — retorna o usuário logado e se já aceitou os termos.
// Lê a sessão do cookie e consulta o D1 pelo último consent do sub.
// ════════════════════════════════════════════════════════════════
import { json, parseCookies, verifySession, SESSION_COOKIE } from './_lib.js';

export async function onRequestGet(context) {
  const { env, request } = context;
  const cookies = parseCookies(request);
  const session = await verifySession(cookies[SESSION_COOKIE], env.SESSION_SECRET || '');

  if (!session || !session.user) {
    return json({ user: null });
  }

  let consent = null;
  try {
    if (env.DB) {
      const row = await env.DB
        .prepare(
          'SELECT termo_versao, termo_hash, accepted_at FROM consents WHERE sub = ? ORDER BY accepted_at DESC LIMIT 1'
        )
        .bind(session.user.sub)
        .first();
      if (row) {
        consent = {
          accepted: true,
          termo_versao: row.termo_versao,
          termo_hash: row.termo_hash,
          accepted_at: row.accepted_at,
        };
      }
    }
  } catch (_e) {
    // se o D1 falhar, trata como sem consent (usuário verá o opt-in de novo)
  }

  return json({ user: session.user, consent });
}
