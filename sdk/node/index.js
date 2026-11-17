// @ts-check
/**
 * abuseguard Node SDK. Zero dependencies, Node 22+. It only hashes identifiers, calls the API with a hard
 * deadline, and falls back. No scoring logic lives here. Must pass contracts/CONFORMANCE.md.
 */
import { createHmac } from 'node:crypto';

const SPEC_VERSION = '1.0.0';

/** Same output as the core `hashId`: first 32 hex chars of HMAC-SHA256(salt, raw). */
export const hashId = (salt, raw) => createHmac('sha256', String(salt)).update(String(raw)).digest('hex').slice(0, 32);

/** Verdict returned when the service is slow, down or unreachable. Open: allow. Closed: step-up. Never a block. */
export function fallbackVerdict(subject, failMode = 'open') {
  const closed = failMode === 'closed';
  return {
    spec_version: SPEC_VERSION, subject: subject ?? null, class: 'inconclusive',
    decision: closed ? 'step_up' : 'allow', enforced: closed, effective_decision: closed ? 'step_up' : 'allow',
    confidence: 0, reasons: ['ENGINE_UNAVAILABLE'], scores: { farm: 0, scraper: 0, legit: 0, cost_ratio: 0 },
    action: closed ? { type: 'step_up', step: 'email_confirm', alternatives: ['passkey', 'manual_review'] } : null,
    recovery: closed ? { appeal: true, paths: ['email_confirm', 'passkey', 'manual_review', 'appeal'], sla_hours: 24 } : null,
    cost: { attributed_usd: 0, budget_usd: 0 },
  };
}

/**
 * One assessment. Never throws. 4xx responses are returned as `{error, status}` so integration bugs stay visible.
 * @param {string} baseUrl  @param {any} input
 * @param {{timeoutMs?: number, failMode?: 'open'|'closed', apiKey?: string, headers?: Record<string,string>}} [opts]
 */
export async function assess(baseUrl, input, opts = {}) {
  const { timeoutMs = 150, failMode = 'open', apiKey = '', headers = {} } = opts;
  try {
    const res = await fetch(`${baseUrl}/v1/decisions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}`, ...headers },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status >= 400 && res.status < 500) return { error: await res.json().catch(() => ({})), status: res.status };
    if (!res.ok) throw new Error(`upstream ${res.status}`);
    return await res.json();
  } catch {
    return fallbackVerdict(input?.subject, failMode);
  }
}

/** Map an enforced verdict to an HTTP response, or null when the request should proceed. */
export function toHttp(verdict) {
  if (!verdict || verdict.error || !verdict.enforced || verdict.decision === 'allow') return null;
  const body = { decision: verdict.decision, decision_id: verdict.decision_id, reasons: verdict.reasons, action: verdict.action, recovery: verdict.recovery };
  const retry = verdict.action?.retry_after_s ? { 'retry-after': String(Math.ceil(verdict.action.retry_after_s)) } : {};
  if (verdict.decision === 'slow' && verdict.action?.mode === 'cached') return { status: 304, headers: {}, body: null };
  if (verdict.decision === 'slow' || verdict.decision === 'limit') return { status: 429, headers: retry, body };
  return { status: 403, headers: {}, body }; // step_up and block: the body tells the client what to do next
}

/**
 * @param {{baseUrl: string, apiKey: string, salt: string, timeoutMs?: number, failMode?: 'open'|'closed', flushMs?: number}} options
 */
export function createClient(options) {
  const { baseUrl, apiKey, salt, timeoutMs = 150, failMode = 'open', flushMs = 2000 } = options;
  if (!baseUrl || !apiKey || !salt) throw new TypeError('createClient needs baseUrl, apiKey and salt');
  let queue = [], timer = null;
  const hash = (raw) => hashId(salt, raw);
  const subject = (kind, rawId) => ({ kind, id: hash(rawId) });

  async function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    const events = queue; queue = [];
    for (let i = 0; i < events.length; i += 1000) {
      try {
        await fetch(`${baseUrl}/v1/events`, {
          method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ events: events.slice(i, i + 1000) }), signal: AbortSignal.timeout(5000),
        });
      } catch { /* usage events are best effort; never break the caller */ }
    }
  }
  /** Queue a usage, link, signup or conversion event. Sent in batches; call flush() before exit. */
  function track(event) {
    queue.push({ ts: new Date().toISOString(), ...event });
    if (queue.length >= 1000) return void flush();
    if (!timer) { timer = setTimeout(flush, flushMs); timer.unref?.(); }
  }

  /**
   * Connect/Express-style middleware. `identify(req)` returns `{subject, context?, behavior?, signals?}` or null
   * to skip. In shadow mode it only sets the `AG-Decision` header.
   */
  function middleware(identify) {
    return async (req, res, next) => {
      let verdict = null;
      try {
        const input = await identify(req);
        if (input?.subject) verdict = await assess(baseUrl, input, { timeoutMs, failMode, apiKey });
      } catch { verdict = null; }
      if (verdict && !verdict.error) {
        req.abuseguard = verdict;
        res.setHeader('AG-Decision', `${verdict.decision}; class=${verdict.class}; enforced=${verdict.enforced}`);
      }
      const out = toHttp(verdict);
      if (!out) return next();
      res.statusCode = out.status;
      for (const [name, value] of Object.entries(out.headers)) res.setHeader(name, value);
      if (out.body) res.setHeader('content-type', 'application/json');
      res.end(out.body ? JSON.stringify(out.body) : undefined);
    };
  }

  return {
    hash, subject, track, flush, middleware,
    assess: (input, opts = {}) => assess(baseUrl, input, { timeoutMs, failMode, apiKey, ...opts }),
  };
}
