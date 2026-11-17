// @ts-check
/** In-memory store adapter for tests, demos and single-process shadow runs. */
import { subjectKey } from '../scoring.js';
import { assertStore } from './interface.js';

export function createMemoryStore(now = () => Date.now()) {
  const subjects = new Map(), byValue = new Map(), bySubject = new Map(), usage = new Map();
  const decisions = new Map(), appeals = new Map(), outcomes = new Map(), policies = new Map();
  let seq = 0;
  const sk = (tenant, subject) => `${tenant}|${subjectKey(subject)}`;
  const getSet = (map, key) => map.get(key) ?? map.set(key, new Set()).get(key);

  const members = (tenant, subject, types) => {
    const set = new Set([subjectKey(subject)]);
    for (const type of types) {
      for (const value of bySubject.get(`${sk(tenant, subject)}|${type}`) ?? []) {
        for (const member of byValue.get(`${tenant}|${type}|${value}`) ?? []) set.add(member);
      }
    }
    return set;
  };

  return assertStore({
    async upsertSubject(tenant, subject, attrs = {}) {
      const key = sk(tenant, subject), prev = subjects.get(key);
      subjects.set(key, { ...subject, first_seen: prev?.first_seen ?? now(), attrs: { ...prev?.attrs, ...attrs }, last_seen: now() });
      return key;
    },
    async getSubject(tenant, subject) { return subjects.get(sk(tenant, subject)) ?? null; },
    async linkAttribute(tenant, subject, type, valueHash) {
      getSet(byValue, `${tenant}|${type}|${valueHash}`).add(subjectKey(subject));
      getSet(bySubject, `${sk(tenant, subject)}|${type}`).add(valueHash);
    },
    async clusterSize(tenant, subject, type) { return members(tenant, subject, [type]).size; },
    async clusterUsage(tenant, subject, windowStart, types) {
      const total = { requests: 0, cost_usd: 0 };
      for (const member of members(tenant, subject, types)) {
        const cur = usage.get(`${tenant}|${member}|${windowStart}`);
        total.requests += cur?.requests ?? 0; total.cost_usd += cur?.cost_usd ?? 0;
      }
      return total;
    },
    async addUsage(tenant, subject, windowStart, delta) {
      const key = `${sk(tenant, subject)}|${windowStart}`, cur = usage.get(key) ?? { requests: 0, cost_usd: 0, at: now() };
      cur.requests += delta.requests ?? 0; cur.cost_usd += delta.cost_usd ?? 0;
      usage.set(key, cur);
      return { requests: cur.requests, cost_usd: cur.cost_usd };
    },
    async getUsage(tenant, subject, windowStart) {
      const cur = usage.get(`${sk(tenant, subject)}|${windowStart}`);
      return { requests: cur?.requests ?? 0, cost_usd: cur?.cost_usd ?? 0 };
    },
    async saveDecision(tenant, verdict) {
      const id = `dec_${++seq}`;
      decisions.set(id, { id, tenant, created_at: now(), verdict });
      return id;
    },
    async getDecision(tenant, id) {
      const row = decisions.get(id);
      return row && row.tenant === tenant ? { id, created_at: row.created_at, ...row.verdict } : null;
    },
    async saveAppeal(tenant, decisionId, appeal = {}) {
      if (decisions.get(decisionId)?.tenant !== tenant) throw new Error('decision not found');
      const id = `app_${++seq}`;
      appeals.set(id, { id, tenant, decision_id: decisionId, status: 'open', outcome: null, created_at: now(), ...appeal });
      return id;
    },
    async resolveAppeal(tenant, appealId, outcome) {
      const row = appeals.get(appealId);
      if (!row || row.tenant !== tenant) throw new Error('appeal not found');
      Object.assign(row, { status: 'resolved', outcome, resolved_at: now() });
    },
    async saveOutcome(tenant, decisionId, label) {
      if (decisions.get(decisionId)?.tenant !== tenant) throw new Error('decision not found');
      outcomes.set(decisionId, label);
    },
    async accuracy(tenant) {
      const mine = [...decisions.values()].filter((d) => d.tenant === tenant);
      const filed = [...appeals.values()].filter((a) => a.tenant === tenant);
      const flagged = mine.filter((d) => d.verdict.decision !== 'allow'), labelled = flagged.filter((d) => outcomes.has(d.id));
      return { decisions: mine.length, non_allow: flagged.length, appeals: filed.length,
        overturned: filed.filter((a) => a.outcome === 'overturned').length,
        labelled: labelled.length, labelled_abusive: labelled.filter((d) => outcomes.get(d.id) === 'abusive').length };
    },
    async getPolicy(tenant) { return policies.get(tenant) ?? null; },
    async putPolicy(tenant, policy) { policies.set(tenant, policy); return policy; },
    async purge(tenant, olderThanMs) {
      const cutoff = now() - olderThanMs;
      let removed = 0;
      for (const [id, d] of decisions) if (d.tenant === tenant && d.created_at < cutoff) { decisions.delete(id); outcomes.delete(id); removed++; }
      for (const [id, a] of appeals) if (a.tenant === tenant && a.created_at < cutoff) { appeals.delete(id); removed++; }
      for (const [key, u] of usage) if (key.startsWith(`${tenant}|`) && u.at < cutoff) { usage.delete(key); removed++; }
      return removed;
    },
    async eraseSubject(tenant, subject) {
      const key = sk(tenant, subject), member = subjectKey(subject);
      subjects.delete(key);
      for (const k of [...usage.keys()]) if (k.startsWith(`${key}|`)) usage.delete(k);
      for (const k of [...bySubject.keys()]) if (k.startsWith(`${key}|`)) bySubject.delete(k);
      for (const [k, set] of byValue) if (k.startsWith(`${tenant}|`)) set.delete(member);
      for (const [id, d] of decisions) if (d.tenant === tenant && d.verdict.subject && subjectKey(d.verdict.subject) === member) decisions.delete(id);
    },
    async close() {},
  });
}
