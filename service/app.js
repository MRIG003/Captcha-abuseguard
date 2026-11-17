// @ts-check
/** HTTP service over the reference core (contracts/openapi.yaml). node:http only, zero dependencies. */
import { createHash, timingSafeEqual } from 'node:crypto';
import { SPEC_VERSION, DEFAULT_CONFIG, decide, explain, attributeCost, analyzeLines, subjectKey } from '../src/index.js';

const KINDS = ['account', 'api_key', 'session', 'device_cluster', 'payment_instrument'];
const LINK_TYPES = ['device', 'payment', 'ip', 'email_domain'];
const ATTRS = ['paying', 'tenure_days', 'email_confirmed', 'passkey', 'card_on_file', 'disposable_email'];
const JSON_LIMIT = 256 * 1024, AUDIT_LIMIT = 64 * 1024 * 1024, SIGNAL_TTL_MS = 86400_000;

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
export function createApp({ store, config = DEFAULT_CONFIG, apiKeys = '', now = () => Date.now() }) {
  const tenantFor = parseApiKeys(apiKeys);
  const signalCache = new Map(), audits = new Map();
  let auditSeq = 0;

  const send = (res, status, body, type = 'application/json') => {
    res.writeHead(status, { 'content-type': type, 'ag-spec-version': SPEC_VERSION, 'cache-control': 'no-store' });
    res.end(body === undefined ? undefined : JSON.stringify(body));
  };
  const tenantConfig = (policy) => ({
    ...config, ...(policy?.thresholds ?? {}),
    mode: policy?.mode ?? config.mode, budgetUsd: policy?.budget_usd ?? config.budgetUsd, windowS: policy?.window_s ?? config.windowS,
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
    return {
      cfg,
      request: {
        ...input, subject, signals,
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
      await store.addUsage(tenant, subject, windowStart(cfg), { requests: u.requests ?? 1, cost_usd: attributeCost(u, cfg) });
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
      const { cfg, request } = await enrich(tenant, await readJson(req));
      const verdict = decide(request, cfg);
      return send(res, 200, { decision_id: await store.saveDecision(tenant, verdict), ...verdict });
    }
    if (a === 'decisions' && b && !c && m === 'GET') return send(res, 200, await decisionOr404(tenant, b));
    if (a === 'decisions' && c === 'explanation' && m === 'GET') return send(res, 200, explain(await decisionOr404(tenant, b)));
    if (a === 'decisions' && c === 'appeal' && m === 'POST') {
      const body = await readJson(req);
      const id = await notFound(store.saveAppeal(tenant, b, { channel: body.channel ?? 'api', note: typeof body.note === 'string' ? body.note.slice(0, 2000) : null }));
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
      await notFound(store.resolveAppeal(tenant, b, outcome));
      return send(res, 200, { id: b, status: 'resolved', outcome });
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
    if (a === 'subjects' && b && c) {
      const subject = needSubject({ kind: b, id: decodeURIComponent(c) });
      if (m === 'DELETE') { await store.eraseSubject(tenant, subject); signalCache.delete(`${tenant}|${subjectKey(subject)}`); return send(res, 204); }
      if (m === 'GET') {
        const stored = await store.getSubject(tenant, subject);
        if (!stored) throw new Problem(404, 'Not Found', 'subject');
        const policy = await store.getPolicy(tenant), cfg = tenantConfig(policy), start = windowStart(cfg);
        const usage = await store.clusterUsage(tenant, subject, start, ['device', 'payment']);
        const clusters = {};
        for (const type of ['device', 'payment', 'ip']) clusters[type] = await store.clusterSize(tenant, subject, type);
        return send(res, 200, { subject, clusters, converted: stored.attrs?.converted === true,
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
    if (a === 'policy' && m === 'GET') return send(res, 200, (await store.getPolicy(tenant)) ?? {});
    if (a === 'policy' && m === 'PUT') {
      const policy = await readJson(req);
      if (policy.mode && !['shadow', 'enforce'].includes(policy.mode)) throw new Problem(400, 'Invalid Request', 'mode must be shadow or enforce');
      if (policy.budget_usd !== undefined && !(policy.budget_usd >= 0)) throw new Problem(400, 'Invalid Request', 'budget_usd must be a non-negative number');
      const agents = (await store.getPolicy(tenant))?.agents;
      return send(res, 200, await store.putPolicy(tenant, { ...(agents ? { agents } : {}), ...policy }));
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
    if (['agent-passes', 'signal-providers', 'webhook-endpoints'].includes(a)) throw new Problem(501, 'Not Implemented', `${a} is specified in the contract but not built yet (docs/BACKLOG.md)`);
    throw new Problem(404, 'Not Found', `${m} ${url.pathname}`);
  }

  return async (req, res) => {
    try { await route(req, res); } catch (err) {
      const p = err instanceof Problem ? err : new Problem(500, 'Internal Error', 'unexpected error');
      if (!(err instanceof Problem)) console.error(JSON.stringify({ level: 'error', msg: String(err?.stack ?? err) }));
      if (res.headersSent) return void res.end();
      res.writeHead(p.status, { 'content-type': 'application/problem+json', 'ag-spec-version': SPEC_VERSION });
      res.end(JSON.stringify({ type: `https://abuseguard.dev/problems/${p.title.toLowerCase().replace(/\s+/g, '-')}`, title: p.title, status: p.status, detail: p.detail }));
    }
  };
}
