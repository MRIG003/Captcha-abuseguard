-- abuseguard schema v1 (PostgreSQL 14+). Used by src/store/postgres.js.
-- Rules: every table is tenant-scoped; identifiers are keyed hashes (never raw IP, email, key or card);
-- retention is enforced by store.purge(); erasure by store.eraseSubject(). Store adapter interface: src/store/interface.js.

CREATE TABLE IF NOT EXISTS schema_version (version int PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
INSERT INTO schema_version (version) VALUES (1) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS tenants (
  id             text PRIMARY KEY,
  name           text NOT NULL,
  region         text NOT NULL DEFAULT 'eu',            -- data residency: rows never leave this region
  hash_salt_ref  text NOT NULL,                         -- reference to the salt in the secret manager, not the salt
  retention_days int  NOT NULL DEFAULT 90 CHECK (retention_days BETWEEN 1 AND 730),
  policy         jsonb NOT NULL DEFAULT '{}'::jsonb,    -- openapi Policy
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Subject model: kind + hashed id. subject_key = kind || ':' || id.
CREATE TABLE IF NOT EXISTS subjects (
  tenant_id   text NOT NULL,                             -- no FK: a tenants row exists only once a policy is saved
  subject_key text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('account','api_key','session','device_cluster','payment_instrument')),
  attrs       jsonb NOT NULL DEFAULT '{}'::jsonb,       -- plan, paying, email_confirmed, passkey, card_on_file, converted
  first_seen  timestamptz NOT NULL DEFAULT now(),
  last_seen   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, subject_key)
);

-- A subject is linked to hashed attributes; subjects sharing a value form a cluster.
CREATE TABLE IF NOT EXISTS subject_links (
  tenant_id   text NOT NULL,
  link_type   text NOT NULL CHECK (link_type IN ('device','payment','ip','email_domain')),
  value_hash  text NOT NULL,
  subject_key text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, link_type, value_hash, subject_key)
);
CREATE INDEX IF NOT EXISTS subject_links_by_subject ON subject_links (tenant_id, subject_key, link_type);

-- Cost attributed per subject per budget window.
CREATE TABLE IF NOT EXISTS usage_windows (
  tenant_id    text NOT NULL,
  subject_key  text NOT NULL,
  window_start timestamptz NOT NULL,
  requests     bigint NOT NULL DEFAULT 0,
  cost_usd     numeric(14,6) NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, subject_key, window_start)
);

CREATE TABLE IF NOT EXISTS signals (
  tenant_id   text NOT NULL,
  subject_key text NOT NULL,
  type        text NOT NULL,
  value       jsonb NOT NULL,
  confidence  real NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  provenance  text NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS signals_by_subject ON signals (tenant_id, subject_key, type, observed_at DESC);

CREATE TABLE IF NOT EXISTS decisions (
  id           text PRIMARY KEY,
  tenant_id    text NOT NULL,
  subject_key  text,
  class        text NOT NULL,
  decision     text NOT NULL CHECK (decision IN ('allow','step_up','slow','limit','block')),
  enforced     boolean NOT NULL,
  confidence   real NOT NULL,
  reasons      text[] NOT NULL,
  verdict      jsonb NOT NULL,                          -- full openapi Verdict
  spec_version text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS decisions_by_subject ON decisions (tenant_id, subject_key, created_at DESC);
CREATE INDEX IF NOT EXISTS decisions_by_time ON decisions (tenant_id, created_at);

CREATE TABLE IF NOT EXISTS appeals (
  id          text PRIMARY KEY,
  tenant_id   text NOT NULL,
  decision_id text NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  outcome     text CHECK (outcome IN ('overturned','upheld')),
  channel     text NOT NULL DEFAULT 'api',
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE INDEX IF NOT EXISTS appeals_by_tenant ON appeals (tenant_id, status, created_at);

-- Ground-truth labels for the per-tenant accuracy report.
CREATE TABLE IF NOT EXISTS outcomes (
  tenant_id   text NOT NULL,
  decision_id text NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  label       text NOT NULL CHECK (label IN ('abusive','legitimate','converted')),
  source      text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, decision_id)
);

CREATE TABLE IF NOT EXISTS agent_policies (
  tenant_id text NOT NULL,
  agent_id  text NOT NULL,                              -- 'default' applies when no row matches
  policy    jsonb NOT NULL,                             -- openapi AgentPolicy
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, agent_id)
);

-- Passes are stored as hashes; the token is shown once.
CREATE TABLE IF NOT EXISTS agent_passes (
  id                    text PRIMARY KEY,
  tenant_id             text NOT NULL,
  agent_id              text NOT NULL,
  subject_key           text NOT NULL,
  client_key_thumbprint text NOT NULL,
  scopes                text[] NOT NULL DEFAULT '{}',
  token_hash            text NOT NULL,
  expires_at            timestamptz NOT NULL,
  revoked_at            timestamptz
);
CREATE INDEX IF NOT EXISTS agent_passes_by_subject ON agent_passes (tenant_id, subject_key, expires_at);

CREATE TABLE IF NOT EXISTS audits (
  id         text PRIMARY KEY,
  tenant_id  text NOT NULL,
  status     text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed')),
  request    jsonb NOT NULL,
  report     jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS webhook_endpoints (
  tenant_id   text NOT NULL,
  url         text NOT NULL,
  secret_hash text NOT NULL,
  events      text[] NOT NULL,
  PRIMARY KEY (tenant_id, url)
);
