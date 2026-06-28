-- ════════════════════════════════════════════════════════════════
-- schema.sql — tabela de aceites (Bola de Cristal)
-- Cloudflare D1 (SQLite). Aplique com:
--   npx wrangler d1 execute meubtc-consents --file=schema.sql --remote
-- ════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS consents (
  id              TEXT PRIMARY KEY,      -- ID único do registro
  sub             TEXT NOT NULL,         -- ID único do Google (subject)
  name            TEXT,                  -- nome do usuário (Google)
  email           TEXT,                  -- e-mail (Google)
  email_verified  INTEGER DEFAULT 0,     -- 1 = e-mail verificado pelo Google
  termo_versao    TEXT NOT NULL,         -- ex: "Termos v1.0 — 2026-06-28"
  termo_hash      TEXT NOT NULL,         -- SHA-256 do texto do termo aceito
  ip              TEXT,                  -- IP do usuário no aceite
  user_agent      TEXT,                  -- navegador/dispositivo
  country         TEXT,                  -- país (via Cloudflare)
  accepted_at     TEXT NOT NULL          -- timestamp ISO 8601 (UTC) do aceite
);

-- Índices para auditoria/consulta
CREATE INDEX IF NOT EXISTS idx_consents_sub   ON consents(sub);
CREATE INDEX IF NOT EXISTS idx_consents_email ON consents(email);
CREATE INDEX IF NOT EXISTS idx_consents_date  ON consents(accepted_at);
