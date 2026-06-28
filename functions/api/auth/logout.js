// ════════════════════════════════════════════════════════════════
// /api/auth/logout — encerra a sessão (limpa o cookie).
// ════════════════════════════════════════════════════════════════
import { json, cookieHeader, SESSION_COOKIE } from './_lib.js';

export async function onRequestPost() {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': cookieHeader(SESSION_COOKIE, '', 0),
      'Cache-Control': 'no-store',
    },
  });
}

// também aceita GET para conveniência
export async function onRequestGet() {
  return onRequestPost();
}
