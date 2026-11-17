// @ts-check
/**
 * Live request-stream features (signal layers 2 to 5) per subject, kept in this process's memory.
 * Same feature code as the log audit (src/features.js). State is per process: several service instances each
 * see only their own share of traffic (docs/SCORECARD.md lists this limit).
 */
import { newStats, arrive, complete, behaviorOf, uaClass, ASSET } from '../src/index.js';

/**
 * @param {{maxSubjects?: number, idleMs?: number, maxAgeMs?: number, recentMinutes?: number}} [options]
 *   idleMs: a subject silent for this long starts fresh. maxAgeMs: statistics are restarted after this long.
 */
export function createLiveTracker({ maxSubjects = 100_000, idleMs = 3600_000, maxAgeMs = 48 * 3600_000, recentMinutes = 60 } = {}) {
  const subjects = new Map(), sites = new Map();

  function open(key, ts) {
    let rec = subjects.get(key);
    if (rec && (ts - rec.stats.last > idleMs || ts - rec.stats.first > maxAgeMs)) rec = undefined;
    if (!rec) rec = { stats: newStats(ts), ua: null };
    subjects.delete(key); subjects.set(key, rec); // most recently used last
    if (subjects.size > maxSubjects) subjects.delete(subjects.keys().next().value);
    return rec;
  }

  return {
    /** A request arrived. `e`: {ts, path, ua?}. */
    arrive(tenant, subjectKey, e, opts) {
      const rec = open(`${tenant}|${subjectKey}`, e.ts);
      if (typeof e.ua === 'string') rec.ua = uaClass(e.ua);
      arrive(rec.stats, e, opts);
      const site = sites.get(tenant) ?? { requests: 0, assets: 0 };
      site.requests++; if (ASSET.test(e.path)) site.assets++;
      sites.set(tenant, site);
    },
    /** The response is known. `e`: {path, status, bytes?, rt?}. Returns dollars attributed (0 for an unknown subject). */
    complete(tenant, subjectKey, e, opts, cfg) {
      const rec = subjects.get(`${tenant}|${subjectKey}`);
      return rec ? complete(rec.stats, e, opts, cfg) : 0;
    },
    /** Behaviour fields for the engine, or null when nothing has been seen. */
    behavior(tenant, subjectKey) {
      const rec = subjects.get(`${tenant}|${subjectKey}`);
      if (!rec) return null;
      const site = sites.get(tenant);
      // Until the site has shown enough traffic we assume it serves assets; after that we measure it.
      const siteHasAssets = !site || site.requests < 200 || site.assets / site.requests >= 0.01;
      return { ...behaviorOf(rec.stats, { siteHasAssets, recentMinutes }), ...(rec.ua ? { ua: rec.ua } : {}) };
    },
    forget(tenant, subjectKey) { subjects.delete(`${tenant}|${subjectKey}`); },
    get size() { return subjects.size; },
  };
}
