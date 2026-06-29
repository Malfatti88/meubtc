/**
 * meuBTC — Cloudflare Pages Function
 * Caminho no repositório:  functions/api/news.js
 * Servido em:              https://meubtc.pages.dev/api/news
 * -----------------------------------------------------------------------
 * Busca os feeds RSS de notícias do lado do SERVIDOR (sem CORS, sem proxy
 * de terceiros) e cacheia no KV. O conteúdo é atualizado no máximo a cada
 * NEWS_TTL horas — assim o usuário sempre recebe a versão cacheada (rápida)
 * e os feeds só são consultados de tempos em tempos, não a cada visita.
 *
 * Configuração (Pages > Settings > Functions > KV namespace bindings):
 *   Variable name: ONCHAIN_KV   (reusa o mesmo namespace do onchain.js)
 *
 * Sem chaves/segredos. Feeds RSS são públicos.
 */

const CACHE_KEY = 'news:latest';
const NEWS_TTL_HOURS = 3;                       // atualiza no máx. 1x a cada 3h
const NEWS_TTL_MS = NEWS_TTL_HOURS * 60 * 60 * 1000;
const UPSTREAM_TIMEOUT_MS = 8000;
const MAX_ITEMS = 30;                            // total guardado
const MAX_PER_FEED = 10;

const FEEDS = [
  { url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', source: 'CoinDesk' },
  { url: 'https://cointelegraph.com/rss',                   source: 'Cointelegraph' },
  { url: 'https://bitcoinmagazine.com/.rss/full/',          source: 'Bitcoin Magazine' },
  { url: 'https://decrypt.co/feed',                         source: 'Decrypt' },
];

const BULL = ['alta','high','ath','record','surge','rally','gains','adoption','approved','etf inflow','institutional','accumulate','bullish','rise','pump','breakout','support','buy','growth','halving','milestone','partnership','launch','upgrade','legal','clarity'];
const BEAR = ['queda','crash','dump','sell','bearish','fear','loss','drop','decline','hack','exploit','ban','restrict','lawsuit','fine','penalty','outflow','liquidation','correction','resistance','fail','scam','fraud','bubble','warning','risk','sanctions','seized','arrested'];

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      // o navegador pode cachear por 30min; o KV controla o refresh real
      'Cache-Control': 'public, max-age=1800',
    },
  });
}

function decodeEntities(s) {
  if (!s) return '';
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/&#8217;/g, "'").replace(/&#8216;/g, "'")
    .replace(/&#8220;/g, '"').replace(/&#8221;/g, '"').replace(/&#8230;/g, '…')
    .replace(/\s+/g, ' ')
    .trim();
}

function scoreSentiment(text) {
  const t = (text || '').toLowerCase();
  let s = 0;
  BULL.forEach(w => { if (t.includes(w)) s++; });
  BEAR.forEach(w => { if (t.includes(w)) s--; });
  return s > 0 ? 'bull' : s < 0 ? 'bear' : 'neut';
}

// Parser simples de RSS/Atom usando regex (Workers não têm DOMParser)
function parseFeed(xml, source) {
  const items = [];
  if (!xml) return items;
  // tenta <item> (RSS) e depois <entry> (Atom)
  const blocks = xml.match(/<item[\s\S]*?<\/item>/gi) || xml.match(/<entry[\s\S]*?<\/entry>/gi) || [];
  for (const block of blocks.slice(0, MAX_PER_FEED)) {
    const tag = (name) => {
      const m = block.match(new RegExp('<' + name + '[^>]*>([\\s\\S]*?)<\\/' + name + '>', 'i'));
      return m ? decodeEntities(m[1]) : '';
    };
    const title = tag('title');
    // ── Extração robusta do link do ARTIGO (não do feed) ──
    let url = '';
    // 1) RSS clássico: <link>https://artigo</link> (texto direto, sem atributos)
    const rssLink = block.match(/<link>\s*([\s\S]*?)\s*<\/link>/i);
    if (rssLink) {
      url = rssLink[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim();
    }
    // 2) Atom: pode ter vários <link rel="..." href="..."/>. Preferimos rel="alternate"
    //    (o link do artigo) e evitamos rel="self"/"edit" (que apontam pro próprio feed).
    if (!url || !/^https?:\/\//i.test(url)) {
      const linkTags = block.match(/<link\b[^>]*\/?>/gi) || [];
      let alternate = '', firstHref = '';
      for (const lt of linkTags) {
        const hrefM = lt.match(/href=["']([^"']+)["']/i);
        if (!hrefM) continue;
        const href = hrefM[1];
        const relM = lt.match(/rel=["']([^"']+)["']/i);
        const rel = relM ? relM[1].toLowerCase() : '';
        if (rel === 'self' || rel === 'edit' || rel === 'hub') continue;
        if (rel === 'alternate' && !alternate) alternate = href;
        if (!firstHref) firstHref = href;
      }
      url = alternate || firstHref || url;
    }
    // 3) Fallback: <guid> que seja permalink (muitos RSS usam o guid como URL)
    if (!url || !/^https?:\/\//i.test(url)) {
      const guid = block.match(/<guid[^>]*>\s*([\s\S]*?)\s*<\/guid>/i);
      if (guid) {
        const g = guid[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim();
        if (/^https?:\/\//i.test(g)) url = g;
      }
    }
    url = (url || '').trim();
    const pub = tag('pubDate') || tag('published') || tag('updated') || '';
    const desc = tag('description') || tag('summary') || '';
    if (!title || !url) continue;
    let published_at = new Date().toISOString();
    if (pub) { const d = new Date(pub); if (!isNaN(d.getTime())) published_at = d.toISOString(); }
    items.push({
      title: title.slice(0, 240),
      url,
      source,
      published_at,
      sentiment: scoreSentiment(title + ' ' + desc),
    });
  }
  return items;
}

async function fetchFeed(feed) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const res = await fetch(feed.url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'meuBTC/1.0 (+https://meubtc.pages.dev)', 'Accept': 'application/rss+xml, application/xml, text/xml, */*' },
      cf: { cacheTtl: 1800, cacheEverything: true },
    });
    if (!res.ok) return [];
    const xml = await res.text();
    return parseFeed(xml, feed.source);
  } catch (e) {
    console.warn('news: feed indisponível (' + feed.source + '):', String(e).slice(0, 100));
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function buildFresh() {
  const results = await Promise.allSettled(FEEDS.map(fetchFeed));
  let all = [];
  let okFeeds = 0;
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value.length) { okFeeds++; all = all.concat(r.value); }
  }
  if (!all.length) return null;
  // ordena por data desc, deduplica por url
  const seen = new Set();
  all = all
    .sort((a, b) => new Date(b.published_at) - new Date(a.published_at))
    .filter(it => { if (seen.has(it.url)) return false; seen.add(it.url); return true; })
    .slice(0, MAX_ITEMS);
  return { ts: Date.now(), feeds_ok: okFeeds, items: all };
}

export async function onRequestGet(context) {
  const { env, request } = context;
  const url = new URL(request.url);
  const force = url.searchParams.get('force') === '1';

  // 1) tenta cache no KV
  let cached = null;
  try {
    if (env.ONCHAIN_KV) {
      const raw = await env.ONCHAIN_KV.get(CACHE_KEY);
      if (raw) cached = JSON.parse(raw);
    }
  } catch (e) { console.warn('news: falha ao ler cache KV:', String(e).slice(0, 120)); }

  const fresh = cached && (Date.now() - cached.ts) < NEWS_TTL_MS;
  if (cached && fresh && !force) {
    return json({ ...cached, source: 'cache', next_update_in_min: Math.round((NEWS_TTL_MS - (Date.now() - cached.ts)) / 60000) });
  }

  // 2) cache vencido ou inexistente → busca novo
  const built = await buildFresh();
  if (built) {
    try {
      if (env.ONCHAIN_KV) {
        await env.ONCHAIN_KV.put(CACHE_KEY, JSON.stringify(built), { expirationTtl: NEWS_TTL_HOURS * 3600 + 3600 });
      }
    } catch (e) { console.warn('news: falha ao gravar cache KV:', String(e).slice(0, 120)); }
    return json({ ...built, source: 'fresh', next_update_in_min: NEWS_TTL_HOURS * 60 });
  }

  // 3) falhou ao buscar → devolve o cache vencido se existir
  if (cached) {
    return json({ ...cached, source: 'stale', stale: true });
  }
  return json({ error: 'news_unavailable', items: [] }, 503);
}
