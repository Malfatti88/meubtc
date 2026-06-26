/**
 * meuBTC — Cloudflare Pages Function
 * Caminho do arquivo no repositório:  functions/api/onchain.js
 * Servido automaticamente em:         https://meubtc.pages.dev/api/onchain
 * -----------------------------------------------------------------------
 * Por que Pages Function (e não Worker separado):
 *   Seu site já é Cloudflare Pages. Colocando este arquivo em
 *   functions/api/onchain.js, o Cloudflare cria a rota /api/onchain
 *   sozinho — mesma origem do site, SEM CORS e SEM wrangler.toml.
 *
 *   Esta função:
 *     - guarda o token da BGeometrics como SECRET (nunca vai ao cliente)
 *     - busca a BGeometrics no máximo 1x/dia e cacheia no KV
 *     - como é same-origin, nem precisa liberar CORS para terceiros
 *     - valida/normaliza toda saída antes de devolver
 *     - falha fechado: sem dado confiável, retorna stale:true / 503
 *
 * Configuração no painel da Cloudflare (Pages > seu projeto > Settings):
 *   1) Functions > KV namespace bindings:
 *        Variable name: ONCHAIN_KV   ->   (crie/selecione um namespace KV)
 *   2) Environment variables > adicionar como "Secret" (encrypt):
 *        BGEO_TOKEN = (seu token NOVO da BGeometrics)
 *
 * Não há chave neste arquivo. Nunca coloque o token aqui.
 */

const CACHE_KEY = 'onchain:latest';
const CACHE_TTL_SECONDS = 24 * 60 * 60; // 1 dia (a fonte atualiza diariamente)
const UPSTREAM_TIMEOUT_MS = 8000;

// Só estas métricas. Menor privilégio: a função não busca nada além disso.
const METRICS = {
  mvrv:    'mvrv',      // MVRV Z-Score
  nupl:    'nupl',      // Net Unrealized Profit/Loss
  picycle: 'pi-cycle',  // Pi Cycle Top (distância entre as médias)
};

const BGEO_BASE = 'https://api.bgeometrics.com/v1/';

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      // same-origin: o cliente pode cachear 10 min; não precisamos de CORS
      'Cache-Control': 'public, max-age=600',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    },
  });
}

// Aceita apenas números finitos dentro de faixas plausíveis. Fora disso -> null.
function sanitizeNumber(raw, min, max) {
  const n = typeof raw === 'string' ? parseFloat(raw) : raw;
  if (typeof n !== 'number' || !isFinite(n)) return null;
  if (n < min || n > max) return null;
  return n;
}

async function fetchUpstreamMetric(path, token) {
  const url = `${BGEO_BASE}${path}/last`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (_e) {
    return null; // fail securely — sem vazar detalhe de erro
  } finally {
    clearTimeout(timer);
  }
}

// Extrai o primeiro valor numérico do payload que não seja data/timestamp.
// A BGeometrics retorna algo como { d:'2026-06-25', unixTs:'...', <metric>:'0.41' }.
function extractValue(payload) {
  if (!payload || typeof payload !== 'object') return null;
  // alguns endpoints retornam array [ {...} ] — pega o último ponto
  const obj = Array.isArray(payload) ? payload[payload.length - 1] : payload;
  if (!obj || typeof obj !== 'object') return null;
  for (const [k, v] of Object.entries(obj)) {
    if (/^(d|date|unixts|timestamp|t)$/i.test(k)) continue;
    const n = sanitizeNumber(v, -100, 1e9);
    if (n !== null) return n;
  }
  return null;
}

async function buildFreshData(token) {
  if (!token) return null;
  const out = { ts: new Date().toISOString(), metrics: {} };
  for (const [key, path] of Object.entries(METRICS)) {
    const payload = await fetchUpstreamMetric(path, token);
    const value = extractValue(payload);
    let bounded = null;
    if (key === 'mvrv')    bounded = sanitizeNumber(value, -2, 15);
    if (key === 'nupl')    bounded = sanitizeNumber(value, -1, 1);
    if (key === 'picycle') bounded = sanitizeNumber(value, 0, 5);
    out.metrics[key] = bounded;
  }
  const anyValid = Object.values(out.metrics).some(v => v !== null);
  return anyValid ? out : null;
}

// Entry point da Pages Function. Responde GET /api/onchain.
export async function onRequestGet(context) {
  const { env } = context;

  // 1) tenta cache
  let cached = null;
  try {
    const raw = await env.ONCHAIN_KV.get(CACHE_KEY);
    if (raw) cached = JSON.parse(raw);
  } catch (_e) { cached = null; }

  const cacheAgeMs = cached ? (Date.now() - new Date(cached.ts).getTime()) : Infinity;
  const cacheFresh = cached && cacheAgeMs < CACHE_TTL_SECONDS * 1000;

  if (cacheFresh) {
    return json({ ...cached, stale: false, source: 'BGeometrics (cache)' }, 200);
  }

  // 2) cache vencido/ausente -> busca nova (no máx 1x/dia, protegido pelo TTL)
  const fresh = await buildFreshData(env.BGEO_TOKEN);
  if (fresh) {
    try {
      await env.ONCHAIN_KV.put(CACHE_KEY, JSON.stringify(fresh), {
        expirationTtl: CACHE_TTL_SECONDS + 3600,
      });
    } catch (_e) { /* falha de escrita no cache — segue servindo o dado fresco */ }
    return json({ ...fresh, stale: false, source: 'BGeometrics' }, 200);
  }

  // 3) upstream falhou -> serve stale se houver (fail securely, não quebra a UI)
  if (cached) {
    return json({ ...cached, stale: true, source: 'BGeometrics (stale)' }, 200);
  }

  // 4) nada disponível
  return json({ error: 'upstream_unavailable', metrics: {}, stale: true }, 503);
}
