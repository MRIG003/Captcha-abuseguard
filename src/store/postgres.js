// @ts-check
/**
 * Postgres store adapter over contracts/schema.sql. Takes any object with `query(text, params)` (a `pg` Pool),
 * so `pg` stays an optional peer dependency. NOT yet run against a live database: see docs/BACKLOG.md T05.
 */
import { randomUUID } from 'node:crypto';
import { subjectKey } from '../scoring.js';
import { assertStore } from './interface.js';

export function createPostgresStore(pool) {
  const q = async (text, params) => (await pool.query(text, params)).rows;
  const win = (ms) => new Date(ms).toISOString();

  return assertStore({
    async upsertSubject(tenant, subject, attrs = {}) {
      await q(`INSERT INTO subjects (tenant_id, subject_key, kind, attrs) VALUES ($1, $2, $3, $4)
        ON CONFLICT (tenant_id, subject_key) DO UPDATE SET last_seen = now(), attrs = subjects.attrs || EXCLUDED.attrs`,
      [tenant, subjectKey(subject), subject.kind, JSON.stringify(attrs)]);
      return `${tenant}|${subjectKey(subject)}`;
    },
    async getSubject(tenant, subject) {
      const rows = await q('SELECT kind, attrs, first_seen, last_seen FROM subjects WHERE tenant_id = $1 AND subject_key = $2', [tenant, subjectKey(subject)]);
      return rows[0] ? { ...subject, ...rows[0] } : null;
    },
    async linkAttribute(tenant, subject, type, valueHash) {
      await q(`INSERT INTO subject_links (tenant_id, link_type, value_hash, subject_key) VALUES ($1, $2, $3, $4)
        ON CONFLICT DO NOTHING`, [tenant, type, valueHash, subjectKey(subject)]);
    },
    async clusterSize(tenant, subject, type) {
      const rows = await q(`SELECT count(DISTINCT b.subject_key)::int AS n FROM subject_links a
        JOIN subject_links b ON b.tenant_id = a.tenant_id AND b.link_type = a.link_type AND b.value_hash = a.value_hash
        WHERE a.tenant_id = $1 AND a.subject_key = $2 AND a.link_type = $3`, [tenant, subjectKey(subject), type]);
      return Math.max(1, rows[0]?.n ?? 0);
    },
    async addUsage(tenant, subject, windowStart, delta) {
      const rows = await q(`INSERT INTO usage_windows (tenant_id, subject_key, window_start, requests, cost_usd)
        VALUES ($1, $2, $3, $4, $5) ON CONFLICT (tenant_id, subject_key, window_start) DO UPDATE
        SET requests = usage_windows.requests + EXCLUDED.requests, cost_usd = usage_windows.cost_usd + EXCLUDED.cost_usd
        RETURNING requests::float8 AS requests, cost_usd::float8 AS cost_usd`,
      [tenant, subjectKey(subject), win(windowStart), delta.requests ?? 0, delta.cost_usd ?? 0]);
      return rows[0];
    },
    async getUsage(tenant, subject, windowStart) {
      const rows = await q(`SELECT requests::float8 AS requests, cost_usd::float8 AS cost_usd FROM usage_windows
        WHERE tenant_id = $1 AND subject_key = $2 AND window_start = $3`, [tenant, subjectKey(subject), win(windowStart)]);
      return rows[0] ?? { requests: 0, cost_usd: 0 };
    },
    async clusterUsage(tenant, subject, windowStart, types) {
      const rows = await q(`SELECT coalesce(sum(u.requests), 0)::float8 AS requests, coalesce(sum(u.cost_usd), 0)::float8 AS cost_usd
        FROM usage_windows u WHERE u.tenant_id = $1 AND u.window_start = $3 AND (u.subject_key = $2 OR u.subject_key IN (
          SELECT b.subject_key FROM subject_links a JOIN subject_links b
            ON b.tenant_id = a.tenant_id AND b.link_type = a.link_type AND b.value_hash = a.value_hash
          WHERE a.tenant_id = $1 AND a.subject_key = $2 AND a.link_type = ANY($4)))`,
      [tenant, subjectKey(subject), win(windowStart), types]);
      return rows[0] ?? { requests: 0, cost_usd: 0 };
    },
    async saveDecision(tenant, verdict) {
      const id = `dec_${randomUUID()}`;
      await q(`INSERT INTO decisions (id, tenant_id, subject_key, class, decision, enforced, confidence, reasons, verdict, spec_version)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [id, tenant, verdict.subject ? subjectKey(verdict.subject) : null, verdict.class, verdict.decision, verdict.enforced,
        verdict.confidence, verdict.reasons, JSON.stringify(verdict), verdict.spec_version]);
      return id;
    },
    async getDecision(tenant, id) {
      const rows = await q('SELECT id, created_at, verdict FROM decisions WHERE tenant_id = $1 AND id = $2', [tenant, id]);
      return rows[0] ? { id: rows[0].id, created_at: rows[0].created_at, ...rows[0].verdict } : null;
    },
    async saveAppeal(tenant, decisionId, appeal = {}) {
      const id = `app_${randomUUID()}`;
      const rows = await q(`INSERT INTO appeals (id, tenant_id, decision_id, channel, note)
        SELECT $1, $2, d.id, $4, $5 FROM decisions d WHERE d.tenant_id = $2 AND d.id = $3 RETURNING id`,
      [id, tenant, decisionId, appeal.channel ?? 'api', appeal.note ?? null]);
      if (!rows.length) throw new Error('decision not found');
      return id;
    },
    async resolveAppeal(tenant, appealId, outcome) {
      const rows = await q(`UPDATE appeals SET status = 'resolved', outcome = $3, resolved_at = now()
        WHERE tenant_id = $1 AND id = $2 RETURNING id`, [tenant, appealId, outcome]);
      if (!rows.length) throw new Error('appeal not found');
    },
    async saveOutcome(tenant, decisionId, label) {
      const rows = await q(`INSERT INTO outcomes (tenant_id, decision_id, label) SELECT $1, d.id, $3 FROM decisions d
        WHERE d.tenant_id = $1 AND d.id = $2 ON CONFLICT (tenant_id, decision_id) DO UPDATE SET label = EXCLUDED.label RETURNING label`,
      [tenant, decisionId, label]);
      if (!rows.length) throw new Error('decision not found');
    },
    async accuracy(tenant) {
      const rows = await q(`SELECT
        (SELECT count(*)::int FROM decisions WHERE tenant_id = $1) AS decisions,
        (SELECT count(*)::int FROM decisions WHERE tenant_id = $1 AND decision <> 'allow') AS non_allow,
        (SELECT count(*)::int FROM appeals WHERE tenant_id = $1) AS appeals,
        (SELECT count(*)::int FROM appeals WHERE tenant_id = $1 AND outcome = 'overturned') AS overturned,
        (SELECT count(*)::int FROM outcomes o JOIN decisions d ON d.id = o.decision_id
          WHERE o.tenant_id = $1 AND d.decision <> 'allow') AS labelled,
        (SELECT count(*)::int FROM outcomes o JOIN decisions d ON d.id = o.decision_id
          WHERE o.tenant_id = $1 AND d.decision <> 'allow' AND o.label = 'abusive') AS labelled_abusive`, [tenant]);
      return rows[0];
    },
    async getPolicy(tenant) {
      return (await q('SELECT policy FROM tenants WHERE id = $1', [tenant]))[0]?.policy ?? null;
    },
    async putPolicy(tenant, policy) {
      await q(`INSERT INTO tenants (id, name, hash_salt_ref, policy) VALUES ($1, $1, 'env:AG_TENANT_SALT', $2)
        ON CONFLICT (id) DO UPDATE SET policy = EXCLUDED.policy`, [tenant, JSON.stringify(policy)]);
      return policy;
    },
    async purge(tenant, olderThanMs) {
      const cutoff = new Date(Date.now() - olderThanMs).toISOString();
      let removed = 0;
      for (const [table, column] of [['appeals', 'created_at'], ['decisions', 'created_at'], ['usage_windows', 'window_start'], ['signals', 'observed_at']]) {
        removed += (await q(`DELETE FROM ${table} WHERE tenant_id = $1 AND ${column} < $2 RETURNING 1`, [tenant, cutoff])).length;
      }
      return removed;
    },
    async eraseSubject(tenant, subject) {
      // appeals and outcomes go with their decision (ON DELETE CASCADE)
      for (const table of ['decisions', 'usage_windows', 'signals', 'subject_links', 'subjects']) {
        await q(`DELETE FROM ${table} WHERE tenant_id = $1 AND subject_key = $2`, [tenant, subjectKey(subject)]);
      }
    },
    async close() { await pool.end?.(); },
  });
}
