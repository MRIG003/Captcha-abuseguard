// @ts-check
/**
 * Request-stream features (signal layers 2 to 5). One implementation, two callers: the batch log audit
 * (src/logAnalyzer.js) and the live tracker in the service, so batch and live can never disagree.
 */
import { DEFAULT_CONFIG, attributeCost } from './scoring.js';

export const ASSET = /\.(css|js|mjs|png|jpe?g|gif|svg|ico|webp|woff2?|ttf|map)(\?|$)/i;
const SEEN_CAP = 5000; // distinct page signatures remembered per subject

/** Fresh running statistics for one subject. */
export const newStats = (ts) => ({
  requests: 0, bytes: 0, cost: 0, minutes: new Map(), seen: new Set(), repeats: 0, robots: 0, errors: 0, converted: false, rpm: 0,
  assets: 0, traps: 0, seq: 0, lastNum: NaN, lastTs: NaN, gapSum: 0, gapSq: 0, hours: new Set(), first: ts, last: ts,
});

/** Count an error response. 401 and 429 are auth or our own replies and are never counted. */
export const isErrorStatus = (status) => status >= 400 && status !== 401 && status !== 429;

/**
 * A request arrives (its outcome is not known yet): rate, order, timing, asset, trap and robots.txt evidence.
 * @param {ReturnType<typeof newStats>} s
 * @param {{ts: number, path: string}} e
 * @param {{disallow?: string[], trapPaths?: string[], convertedPaths?: string[]}} [opts]
 */
export function arrive(s, e, opts = {}) {
  const { disallow = [], trapPaths = [], convertedPaths = [] } = opts;
  s.requests++;
  const minute = Math.floor(e.ts / 60000), n = (s.minutes.get(minute) ?? 0) + 1;
  s.minutes.set(minute, n); s.rpm = Math.max(s.rpm, n);
  if (disallow.some((p) => e.path.startsWith(p))) s.robots++;
  if (convertedPaths.some((p) => e.path.startsWith(p))) s.converted = true;
  if (trapPaths.some((p) => e.path.startsWith(p))) s.traps++;
  if (ASSET.test(e.path)) s.assets++;
  const num = Number(/(\d+)\D*$/.exec(e.path.split('?')[0])?.[1]);
  if (num === s.lastNum + 1) s.seq++;
  s.lastNum = num;
  if (!Number.isNaN(s.lastTs)) { const gap = Math.abs(e.ts - s.lastTs) / 1000; s.gapSum += gap; s.gapSq += gap * gap; }
  s.lastTs = e.ts; s.hours.add(Math.floor(e.ts / 3600000)); s.first = Math.min(s.first, e.ts); s.last = Math.max(s.last, e.ts);
}

/**
 * The response is known: size, unchanged re-fetch, error status and cost. Returns the dollars attributed.
 * @param {ReturnType<typeof newStats>} s
 * @param {{path: string, status?: number, bytes?: number, rt?: number}} e
 * @param {{endpointCosts?: {prefix: string, usd: number}[]}} [opts]
 */
export function complete(s, e, opts = {}, cfg = DEFAULT_CONFIG) {
  const bytes = e.bytes ?? 0, status = e.status ?? 0;
  s.bytes += bytes;
  const endpoint = (opts.endpointCosts ?? []).find((x) => e.path.startsWith(x.prefix));
  const cost = attributeCost({ cpu_s: e.rt ?? 0, bytes, direct_usd: endpoint?.usd ?? 0 }, cfg);
  s.cost += cost;
  const seenKey = `${e.path}|${bytes}`;
  if (status === 304 || s.seen.has(seenKey)) s.repeats++; else if (s.seen.size < SEEN_CAP) s.seen.add(seenKey);
  if (isErrorStatus(status)) s.errors++;
  return cost;
}

/** A finished request in one step (log lines, or events sent after the response). */
export function observe(s, e, opts = {}, cfg = DEFAULT_CONFIG) {
  arrive(s, e, opts);
  return complete(s, e, opts, cfg);
}

/**
 * Behaviour fields for the engine. Ratios need enough requests to mean anything; otherwise they are left out.
 * `recentMinutes` limits peak rate to the last N minutes before `s.last` (live use); omit it for a whole log.
 * `siteHasAssets` false switches off the asset contradiction on sites that serve no images, styles or scripts.
 */
export function behaviorOf(s, { siteHasAssets = true, recentMinutes } = {}) {
  let rpm = s.rpm;
  if (recentMinutes) {
    const cutoff = Math.floor(s.last / 60000) - recentMinutes;
    rpm = 0;
    for (const [minute, count] of s.minutes) { if (minute < cutoff) s.minutes.delete(minute); else rpm = Math.max(rpm, count); }
  }
  const n = s.requests, gaps = n - 1, mean = gaps > 0 ? s.gapSum / gaps : 0, spanH = (s.last - s.first) / 3600000;
  const pattern = n < 30 ? {} : {
    ...(siteHasAssets ? { asset_ratio: s.assets / n } : {}), page_requests: n - s.assets, sequential_ratio: s.seq / n,
    ...(mean >= 1 ? { interval_cv: Math.sqrt(Math.max(0, s.gapSq / gaps - mean * mean)) / mean } : {}),
    ...(spanH >= 24 ? { active_hours_ratio: s.hours.size / Math.ceil(spanH + 1) } : {}),
  };
  return { rpm, robots_violations: s.robots, refetch_unchanged: n >= 20 ? s.repeats / n : 0,
    error_ratio: n >= 20 ? s.errors / n : 0, trap_hits: s.traps, ...pattern };
}
