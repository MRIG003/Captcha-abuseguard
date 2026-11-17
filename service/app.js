// @ts-check
/** HTTP service over the reference core (contracts/openapi.yaml). node:http only, zero dependencies. */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { SPEC_VERSION, DEFAULT_CONFIG, decide, explain, attributeCost, analyzeLines, subjectKey } from '../src/index.js';
import { PRESETS, strictnessConfig } from './presets.js';

const KINDS = ['account', 'api_key', 'session', 'device_cluster', 'payment_instrument'];
const LINK_TYPES = ['device', 'payment', 'ip', 'email_domain'];
const ATTRS = ['paying', 'tenure_days', 'email_confirmed', 'passkey', 'card_on_file', 'disposable_email'];
const JSON_LIMIT = 256 * 1024, AUDIT_LIMIT = 64 * 1024 * 1024, SIGNAL_TTL_MS = 86400_000;
const TRUST_MS = 30 * 86400_000, FLAG_DEDUP_MS = 600_000;
const ACTIONS = ['step_up', 'slow', 'limit', 'block'];
const VERIFY = { email_confirm: 'email_confirmed', passkey: 'passkey', card_on_file: 'card_on_file' };
const EVENTS = ['subject.flagged', 'appeal.filed', 'appeal.resolved'];
const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|\[?::1\]?$|\[?f[cd])/i;

class Problem extends Error {
  constructor(status, title, detail) { super(detail ?? title); this.status = status; this.title = title; this.detail = detail; }
}
const sha = (text) => createHash('sha256').update(text).digest();
const validSubject = (s) => s && KINDS.includes(s.kind) && typeof s.id === 'string' && s.id.length > 0 && s.id.length <= 128;
const needSubject = (s) => { if (!validSubject(s)) throw new Problem(400, 'Invalid Request', 'subject.kind and subject.id are required'); return { kind: s.kind, id: s.id }; };

/** Parse AG_API_KEYS ("tenant:key,tenant2:key2") into a lookup that compares in constant time. */
export function parseApiKeys(text = '') {
  const keys = text.split(',').map((pair) => pair.trim()).filter(Boolean).map((pair) => {
    const at = pair.indexOf(':');
    return { tenant: pair.slice(0, at), digest: sha(pair.slice(at + 1)) };
  }).filter((k) => k.tenant);
  return (token) => {
    const digest = sha(token ?? '');
    let tenant = null;
    for (const k of keys) if (timingSafeEqual(k.digest, digest)) tenant = k.tenant;
    return tenant;
  };
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) { reject(new Problem(413, 'Payload Too Large', `body exceeds ${limit} bytes`)); req.resume(); } else chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
async function readJson(req) {
  const text = await readBody(req, JSON_LIMIT);
  try { const body = JSON.parse(text); if (body && typeof body === 'object') return body; } catch { /* fall through */ }
  throw new Problem(400, 'Invalid Request', 'body is not a JSON object');
}

/**
 * @param {{store: any, config?: any, apiKeys?: string, now?: () => number}} deps
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createApp({ store, config = DEFAULT_CONFIG, apiKeys = '', now = () => Date.now(), allowPrivateWebhooks = false }) {
  const tenantFor = parseApiKeys(apiKeys);
  const signalCache = new Map(), audits = new Map(), flaggedAt = new Map(), pending = new Set();
  let auditSeq = 0, eventSeq = 0;

  /** Signed webhook delivery: best effort, 3 attempts, never blocks or fails the request that caused it. */
  function emit(policy, type, data) {
    for (const hook of policy?.webhooks ?? []) {
      if (!hook.events.includes(type)) continue;
      const body = JSON.stringify({ id: `evt_${now()}_${++eventSeq}`, type, created_at: new Date(now()).toISOString(), data });
      const job = (async () => {
        for (let attempt = 0; attempt < 3; attempt++) {
          const t = Math.floor(now() / 1000), v1 = createHmac('sha256', hook.secret).update(`${t}.${body}`).digest('hex');
          try {
            const res = await fetch(hook.url, { method: 'POST', body, signal: AbortSignal.timeout(3000), redirect: 'error',
              headers: { 'content-type': 'application/json', 'ag-signature': `t=${t},v1=${v1}` } });
            if (res.ok) return;
          } catch { /* retry */ }
          await new Promise((resolve) => setTimeout(resolve, 200 * 2 ** attempt));
        }
      })();
      pending.add(job); job.finally(() => pending.delete(job));
    }
  }
  const publicPolicy = (policy) => (policy?.webhooks ? { ...policy, webhooks: policy.webhooks.map(({ secret, ...rest }) => rest) } : policy ?? {});

  const send = (res, status, body, type = 'application/json') => {
    res.writeHead(status, { 'content-type': type, 'ag-spec-version': SPEC_VERSION, 'cache-control': 'no-store' });
    res.end(body === undefined ? undefined : JSON.stringify(body));
  };
  const tenantConfig = (policy) => ({
    ...config, ...(policy?.thresholds ?? {}), ...strictnessConfig(policy?.strictness),
    ...(policy?.mode ? { mode: policy.mode } : {}), budgetUsd: policy?.budget_usd ?? config.budgetUsd, windowS: policy?.window_s ?? config.windowS,
  });
  const windowStart = (cfg) => Math.floor(now() / (cfg.windowS * 1000)) * cfg.windowS * 1000;
  const budgetFor = (policy, cfg, input) => {
    const hit = (policy?.budgets ?? []).find(({ match = {} }) => (!match.plan || match.plan === input.context?.plan)
      && (!match.endpoint_class || match.endpoint_class === input.context?.endpoint_class)
      && (!match.subject_kind || match.subject_kind === input.subject.kind));
    return hit?.budget_usd ?? cfg.budgetUsd;
  };
  const freshSignals = (tenant, subject) => (signalCache.get(`${tenant}|${subjectKey(subject)}`) ?? [])
    .filter((s) => now() - s.at < SIGNAL_TTL_MS).map(({ at, ...s }) => ({ ...s, freshness_s: (s.freshness_s ?? 0) + Math.round((now() - at) / 1000) }));

  /** Merge what the store knows (clusters, cluster cost, attributes, pushed signals, policy) into the request. */
  async function enrich(tenant, input) {
    const subject = needSubject(input.subject);
    const policy = await store.getPolicy(tenant), cfg = tenantConfig(policy);
    const [stored, device, payment, ip, usage] = await Promise.all([
      store.getSubject(tenant, subject), store.clusterSize(tenant, subject, 'device'), store.clusterSize(tenant, subject, 'payment'),
      store.clusterSize(tenant, subject, 'ip'), store.clusterUsage(tenant, subject, windowStart(cfg), ['device', 'payment']),
    ]);
    const known = Object.fromEntries(ATTRS.filter((k) => stored?.attrs?.[k] !== undefined).map((k) => [k, stored.attrs[k]]));
    const b = input.behavior ?? {}, signals = [...freshSignals(tenant, subject), ...(Array.isArray(input.signals) ? input.signals : [])];
    const agentId = signals.find((s) => s.type === 'agent.credential')?.value?.agent_id;
    const agentPolicy = input.agent_policy ?? policy?.agents?.[agentId] ?? policy?.agents?.default;
    const standing = { trusted: (stored?.attrs?.trusted_until ?? 0) > now() || input.standing?.trusted === true,
      appeal_open: stored?.attrs?.appeal_open === true || input.standing?.appeal_open === true };
    const settings = { ...(policy?.allowed_actions ? { allowed_actions: policy.allowed_actions } : {}), ...(policy?.step_up_order ? { step_up_order: policy.step_up_order } : {}) };
    return {
      cfg, policy,
      request: {
        ...input, subject, signals, standing, policy: { ...settings, ...(input.policy ?? {}) },
        behavior: { ...known, ...b, device_cluster: Math.max(b.device_cluster ?? 0, device), payment_cluster: Math.max(b.payment_cluster ?? 0, payment), ip_cluster: Math.max(b.ip_cluster ?? 0, ip) },
        cost: { usd: input.cost?.usd ?? usage.cost_usd, budget_usd: input.cost?.budget_usd ?? budgetFor(policy, cfg, { ...input, subject }) },
        ...(agentPolicy ? { agent_policy: agentPolicy } : {}),
      },
    };
  }

  async function ingest(tenant, event, cfg) {
    const subject = needSubject(event.subject);
    if (event.type === 'usage') {
      const u = event.usage ?? {};
      await store.upsertSubject(tenant, subject);
      // `amount` counts fair-share units that are not dollars (items, tickets, coupons, pages); see policy.unit.
      await store.addUsage(tenant, subject, windowStart(cfg), { requests: u.requests ?? 1, cost_usd: attributeCost(u, cfg) + (u.amount > 0 ? u.amount : 0) });
    } else if (event.type === 'link') {
      if (!LINK_TYPES.includes(event.link?.link_type) || typeof event.link.value_hash !== 'string') throw new Problem(400, 'Invalid Request', 'link.link_type and link.value_hash are required');
      await store.upsertSubject(tenant, subject);
      await store.linkAttribute(tenant, subject, event.link.link_type, event.link.value_hash);
    } else if (event.type === 'signup') {
      await store.upsertSubject(tenant, subject, Object.fromEntries(ATTRS.filter((k) => event.attrs?.[k] !== undefined).map((k) => [k, event.attrs[k]])));
    } else if (event.type === 'conversion') {
      await store.upsertSubject(tenant, subject, { converted: true, ...(event.attrs?.paying !== undefined ? { paying: !!event.attrs.paying } : {}) });
    } else throw new Problem(400, 'Invalid Request', `unknown event type ${event.type}`);
  }

  const decisionOr404 = async (tenant, id) => (await store.getDecision(tenant, id)) ?? (() => { throw new Problem(404, 'Not Found', `decision ${id}`); })();
  const notFound = (fn) => fn.catch((err) => { throw /not found/.test(err.message) ? new Problem(404, 'Not Found', err.message) : err; });

  async function route(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost'), seg = url.pathname.split('/').filter(Boolean), m = req.method;
    if (m === 'GET' && url.pathname === '/healthz') return send(res, 200, { status: 'ok', spec_version: SPEC_VERSION });
    if (m === 'GET' && url.pathname === '/readyz') {
      try { await store.getPolicy('__ready__'); return send(res, 200, { status: 'ok', spec_version: SPEC_VERSION }); } catch { throw new Problem(503, 'Service Unavailable', 'store is not reachable'); }
    }
    if (m === 'GET' && url.pathname === '/v1/version') return send(res, 200, { api: 'v1', spec_version: SPEC_VERSION });
    if (seg[0] !== 'v1') throw new Problem(404, 'Not Found', url.pathname);

    const tenant = tenantFor(/^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1]);
    if (!tenant) throw new Problem(401, 'Unauthorized', 'missing or unknown bearer token');
    const [, a, b, c] = seg;

    if (a === 'decisions' && !b && m === 'POST') {
      const { cfg, request, policy } = await enrich(tenant, await readJson(req));
      const verdict = decide(request, cfg), id = await store.saveDecision(tenant, verdict);
      const flagKey = `${tenant}|${subjectKey(request.subject)}|${verdict.decision}`;
      if (verdict.decision !== 'allow' && now() - (flaggedAt.get(flagKey) ?? -Infinity) > FLAG_DEDUP_MS) {
        if (flaggedAt.size > 50_000) flaggedAt.clear();
        flaggedAt.set(flagKey, now());
        emit(policy, 'subject.flagged', { decision_id: id, subject: verdict.subject, class: verdict.class, decision: verdict.decision, enforced: verdict.enforced,
          reasons: verdict.reasons, action: verdict.action, cost: verdict.cost });
      }
      return send(res, 200, { decision_id: id, ...verdict });
    }
    if (a === 'decisions' && b && !c && m === 'GET') return send(res, 200, await decisionOr404(tenant, b));
    if (a === 'decisions' && c === 'explanation' && m === 'GET') return send(res, 200, explain(await decisionOr404(tenant, b)));
    if (a === 'decisions' && c === 'appeal' && m === 'POST') {
      const body = await readJson(req);
      const id = await notFound(store.saveAppeal(tenant, b, { channel: body.channel ?? 'api', note: typeof body.note === 'string' ? body.note.slice(0, 2000) : null }));
      const subject = (await store.getDecision(tenant, b))?.subject;
      if (subject) await store.upsertSubject(tenant, subject, { appeal_open: true }); // a block is softened while the appeal is open
      emit(await store.getPolicy(tenant), 'appeal.filed', { appeal_id: id, decision_id: b, subject });
      return send(res, 201, { id, decision_id: b, status: 'open', outcome: null });
    }
    if (a === 'decisions' && c === 'outcome' && m === 'POST') {
      const { label } = await readJson(req);
      if (!['abusive', 'legitimate', 'converted'].includes(label)) throw new Problem(400, 'Invalid Request', 'label must be abusive, legitimate or converted');
      await notFound(store.saveOutcome(tenant, b, label));
      return send(res, 204);
    }
    if (a === 'appeals' && b && m === 'PATCH') {
      const { outcome } = await readJson(req);
      if (!['overturned', 'upheld'].includes(outcome)) throw new Problem(400, 'Invalid Request', 'outcome must be overturned or upheld');
      const decisionId = await notFound(store.resolveAppeal(tenant, b, outcome));
      const subject = (await store.getDecision(tenant, decisionId))?.subject;
      // Overturned: the subject is trusted for 30 days, so the same evidence does not flag it again tomorrow.
      if (subject) await store.upsertSubject(tenant, subject, { appeal_open: false, ...(outcome === 'overturned' ? { trusted_until: now() + TRUST_MS } : {}) });
      emit(await store.getPolicy(tenant), 'appeal.resolved', { appeal_id: b, decision_id: decisionId, subject, outcome });
      return send(res, 200, { id: b, decision_id: decisionId, status: 'resolved', outcome });
    }
    if (a === 'events' && m === 'POST') {
      const { events } = await readJson(req);
      if (!Array.isArray(events) || events.length > 1000) throw new Problem(400, 'Invalid Request', 'events must be an array of at most 1000');
      const cfg = tenantConfig(await store.getPolicy(tenant));
      let accepted = 0, rejected = 0;
      for (const event of events) {
        try { await ingest(tenant, event ?? {}, cfg); accepted++; } catch (err) { if (!(err instanceof Problem)) throw err; rejected++; }
      }
      return send(res, 202, { accepted, rejected });
    }
    if (a === 'subjects' && b && c && seg[4] === 'verifications' && m === 'POST') {
      // The customer reports that a step-up was completed; the next decision sees it and moves on.
      const subject = needSubject({ kind: b, id: decodeURIComponent(c) }), body = await readJson(req);
      const known = [...Object.keys(VERIFY), 'human_check', 'manual_review', 'proof_of_work'];
      if (!known.includes(body.step) || !['pass', 'fail'].includes(body.result)) throw new Problem(400, 'Invalid Request', `step must be one of ${known.join(', ')}; result must be pass or fail`);
      if (body.result === 'pass') {
        if (VERIFY[body.step]) await store.upsertSubject(tenant, subject, { [VERIFY[body.step]]: true });
        else if (body.step === 'manual_review') await store.upsertSubject(tenant, subject, { trusted_until: now() + TRUST_MS, appeal_open: false });
        else {
          const key = `${tenant}|${subjectKey(subject)}`, type = body.step === 'human_check' ? 'human.liveness' : 'client.proof_of_work';
          signalCache.set(key, [...(signalCache.get(key) ?? []), { type, value: 'pass', confidence: 0.9, freshness_s: 0, provenance: 'verification', at: now() }].slice(-50));
          await store.upsertSubject(tenant, subject);
        }
      }
      return send(res, 200, { subject, step: body.step, result: body.result });
    }
    if (a === 'subjects' && b && c && !seg[4]) {
      const subject = needSubject({ kind: b, id: decodeURIComponent(c) });
      if (m === 'DELETE') { await store.eraseSubject(tenant, subject); signalCache.delete(`${tenant}|${subjectKey(subject)}`); return send(res, 204); }
      if (m === 'GET') {
        const stored = await store.getSubject(tenant, subject);
        if (!stored) throw new Problem(404, 'Not Found', 'subject');
        const policy = await store.getPolicy(tenant), cfg = tenantConfig(policy), start = windowStart(cfg);
        const usage = await store.clusterUsage(tenant, subject, start, ['device', 'payment']);
        const clusters = {};
        for (const type of ['device', 'payment', 'ip']) clusters[type] = await store.clusterSize(tenant, subject, type);
        return send(res, 200, { subject, clusters, converted: stored.attrs?.converted === true, unit: policy?.unit ?? 'usd',
          standing: { trusted: (stored.attrs?.trusted_until ?? 0) > now(), appeal_open: stored.attrs?.appeal_open === true },
          window: { start: new Date(start).toISOString(), requests: usage.requests, cost_attributed_usd: usage.cost_usd, budget_usd: budgetFor(policy, cfg, { subject }) } });
      }
    }
    if (a === 'signals' && m === 'POST') {
      const body = await readJson(req), subject = needSubject(body.subject);
      if (!Array.isArray(body.signals) || body.signals.some((s) => typeof s?.type !== 'string' || typeof s.provenance !== 'string')) throw new Problem(400, 'Invalid Request', 'signals need type and provenance');
      const key = `${tenant}|${subjectKey(subject)}`;
      signalCache.set(key, [...freshSignals(tenant, subject).map((s) => ({ ...s, at: now() })), ...body.signals.map((s) => ({ ...s, at: now() }))].slice(-50));
      return send(res, 202, { accepted: body.signals.length });
    }
    if (a === 'presets' && m === 'GET') return send(res, 200, PRESETS);
    if (a === 'policy' && m === 'GET') return send(res, 200, publicPolicy(await store.getPolicy(tenant)));
    if (a === 'policy' && m === 'PUT') {
      const body = await readJson(req);
      if (body.preset !== undefined && !PRESETS[body.preset]) throw new Problem(400, 'Invalid Request', `preset must be one of ${Object.keys(PRESETS).join(', ')}`);
      const policy = { ...(body.preset ? PRESETS[body.preset] : {}), ...body };
      if (policy.strictness && !['watch', 'gentle', 'strict'].includes(policy.strictness)) throw new Problem(400, 'Invalid Request', 'strictness must be watch, gentle or strict');
      if (policy.allowed_actions && !(Array.isArray(policy.allowed_actions) && policy.allowed_actions.every((x) => ACTIONS.includes(x)))) throw new Problem(400, 'Invalid Request', `allowed_actions may contain ${ACTIONS.join(', ')}`);
      if (policy.step_up_order && !Array.isArray(policy.step_up_order)) throw new Problem(400, 'Invalid Request', 'step_up_order must be a list');
      delete policy.webhooks; // managed through /v1/webhook-endpoints
      if (policy.mode && !['shadow', 'enforce'].includes(policy.mode)) throw new Problem(400, 'Invalid Request', 'mode must be shadow or enforce');
      if (policy.budget_usd !== undefined && !(policy.budget_usd >= 0)) throw new Problem(400, 'Invalid Request', 'budget_usd must be a non-negative number');
      const prev = await store.getPolicy(tenant);
      return send(res, 200, publicPolicy(await store.putPolicy(tenant, { ...(prev?.agents ? { agents: prev.agents } : {}), ...policy, ...(prev?.webhooks ? { webhooks: prev.webhooks } : {}) })));
    }
    if (a === 'agent-policies' && b && (m === 'GET' || m === 'PUT')) {
      const policy = (await store.getPolicy(tenant)) ?? {};
      if (m === 'GET') return policy.agents?.[b] ? send(res, 200, policy.agents[b]) : (() => { throw new Problem(404, 'Not Found', `agent policy ${b}`); })();
      const agent = await readJson(req);
      if (!['allow', 'deny'].includes(agent.mode)) throw new Problem(400, 'Invalid Request', 'mode must be allow or deny');
      await store.putPolicy(tenant, { ...policy, agents: { ...policy.agents, [b]: agent } });
      return send(res, 200, agent);
    }
    if (a === 'audits' && !b && m === 'POST') {
      if (/json/.test(req.headers['content-type'] ?? '') && !/ndjson/.test(req.headers['content-type'] ?? '')) throw new Problem(501, 'Not Implemented', 'audit by URL is not implemented; POST log lines as application/x-ndjson or text/plain');
      const q = url.searchParams, lines = (await readBody(req, AUDIT_LIMIT)).split(/\r?\n/);
      const report = analyzeLines(lines, {
        salt: `${tenant}|audit`, config: tenantConfig(await store.getPolicy(tenant)), disallow: q.getAll('disallow'), convertedPaths: q.getAll('converted_path'),
        endpointCosts: q.getAll('endpoint_cost').map((pair) => { const at = pair.lastIndexOf('='); return { prefix: pair.slice(0, at), usd: Number(pair.slice(at + 1)) }; }).filter((x) => x.prefix && x.usd >= 0),
      });
      const id = `aud_${++auditSeq}`;
      audits.set(id, { tenant, id, status: 'done', report });
      return send(res, 202, { id, status: 'done', report });
    }
    if (a === 'audits' && b && m === 'GET') {
      const audit = audits.get(b);
      if (!audit || audit.tenant !== tenant) throw new Problem(404, 'Not Found', `audit ${b}`);
      return send(res, 200, { id: audit.id, status: audit.status, report: audit.report });
    }
    if (a === 'metrics' && b === 'accuracy' && m === 'GET') {
      const acc = await store.accuracy(tenant);
      return send(res, 200, { decisions: acc.decisions, non_allow: acc.non_allow, appeals: acc.appeals, appeals_overturned: acc.overturned,
        labelled_non_allow: acc.labelled, precision: acc.labelled ? acc.labelled_abusive / acc.labelled : null,
        appeal_overturn_rate: acc.appeals ? acc.overturned / acc.appeals : null });
    }
    if (a === 'webhook-endpoints' && m === 'PUT') {
      const { url: target, events = EVENTS } = await readJson(req);
      let parsed;
      try { parsed = new URL(target); } catch { throw new Problem(400, 'Invalid Request', 'url is not a valid URL'); }
      const privateHost = PRIVATE_HOST.test(parsed.hostname);
      if (!allowPrivateWebhooks && (parsed.protocol !== 'https:' || privateHost)) throw new Problem(400, 'Invalid Request', 'webhook url must be https and must not point at a private or local address');
      if (!Array.isArray(events) || !events.every((e) => EVENTS.includes(e))) throw new Problem(400, 'Invalid Request', `events may contain ${EVENTS.join(', ')}`);
      const policy = (await store.getPolicy(tenant)) ?? {}, secret = `whsec_${randomBytes(24).toString('hex')}`;
      const webhooks = [...(policy.webhooks ?? []).filter((h) => h.url !== parsed.href), { url: parsed.href, events, secret }].slice(-5);
      await store.putPolicy(tenant, { ...policy, webhooks });
      return send(res, 200, { url: parsed.href, events, secret });
    }
    if (['agent-passes', 'signal-providers'].includes(a)) throw new Problem(501, 'Not Implemented', `${a} is specified in the contract but not built yet (docs/BACKLOG.md)`);
    throw new Problem(404, 'Not Found', `${m} ${url.pathname}`);
  }

  const handler = async (req, res) => {
    try { await route(req, res); } catch (err) {
      const p = err instanceof Problem ? err : new Problem(500, 'Internal Error', 'unexpected error');
      if (!(err instanceof Problem)) console.error(JSON.stringify({ level: 'error', msg: String(err?.stack ?? err) }));
      if (res.headersSent) return void res.end();
      res.writeHead(p.status, { 'content-type': 'application/problem+json', 'ag-spec-version': SPEC_VERSION });
      res.end(JSON.stringify({ type: `https://abuseguard.dev/problems/${p.title.toLowerCase().replace(/\s+/g, '-')}`, title: p.title, status: p.status, detail: p.detail }));
    }
  };  /** Resolves when all queued webhook deliveries have finished (used on shutdown and in tests). */
  handler.drain = () => Promise.allSettled([...pending]);
  return handler;
}
