// @ts-check
/** Batch log audit: server/CDN logs -> per-subject behaviour and cost -> shadow verdicts -> dollar report. */
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { DEFAULT_CONFIG, attributeCost, hashId } from './scoring.js';
import { decide } from './engine.js';

const CLF = /^(\S+) \S+ \S+ \[([^\]]+)\] "(\S+) (\S+)[^"]*" (\d{3}) (\d+|-)(?: "[^"]*" "([^"]*)")?(?: (\d+(?:\.\d+)?))?/;
const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

function clfTime(text) {
  const m = /^(\d+)\/(\w+)\/(\d+):(\d+):(\d+):(\d+) ([+-])(\d\d)(\d\d)/.exec(text);
  if (!m || !(m[2] in MONTHS)) return NaN;
  const offsetMin = (m[7] === '-' ? -1 : 1) * (Number(m[8]) * 60 + Number(m[9]));
  return Date.UTC(+m[3], MONTHS[m[2]], +m[1], +m[4], +m[5], +m[6]) - offsetMin * 60000;
}

/** Parse one line: JSON ({ts, ip, path, status, bytes, ua, rt, key}) or combined log format with optional request time. */
export function parseLine(line) {
  if (!line) return null;
  if (line[0] === '{') {
    try {
      const j = JSON.parse(line), ts = typeof j.ts === 'number' ? j.ts : Date.parse(j.ts);
      if (typeof j.path !== 'string' || Number.isNaN(ts)) return null;
      return { ts, ip: j.ip ?? '', key: j.key ?? null, path: j.path, status: +j.status || 0, bytes: +j.bytes || 0, ua: j.ua ?? '', rt: +j.rt || 0 };
    } catch { return null; }
  }
  const m = CLF.exec(line), ts = m ? clfTime(m[2]) : NaN;
  if (!m || Number.isNaN(ts)) return null;
  return { ts, ip: m[1], key: null, path: m[4], status: +m[5], bytes: m[6] === '-' ? 0 : +m[6], ua: m[7] ?? '', rt: m[8] ? +m[8] : 0 };
}

const BOT_UA = /bots?\b|crawl|spider|slurp|fetch|archiv|monitor|uptime|check|scan|index|feed|preview|\+https?:\/\/|compatible;(?!\s*MSIE)/i;
const BROWSER_UA = /^(Mozilla|Opera)\/.*(Windows NT|Macintosh|X11|Linux|Android|iPhone|iPad|CrOS).*(AppleWebKit|Gecko|Trident|MSIE|Presto)/;

export function uaClass(ua) {
  if (!ua || ua === '-') return 'empty';
  if (/chatgpt-user|-user\b|\bagent\b|operator/i.test(ua)) return 'declared_agent';
  if (BOT_UA.test(ua)) return 'declared_bot';
  return BROWSER_UA.test(ua) ? 'browser' : 'library';
}

const savedUsd = (verdict, sub, cfg) => {
  if (verdict.decision === 'block') return sub.cost;
  if (verdict.decision === 'limit') return Math.max(0, sub.cost - cfg.budgetUsd);
  if (verdict.decision !== 'slow') return 0;
  if (verdict.action.mode === 'cached') return sub.cost * (sub.repeats / sub.requests);
  return sub.cost * Math.max(0, 1 - cfg.slowRpm / Math.max(sub.rpm, cfg.slowRpm));
};

/**
 * @param {Iterable<string>} lines
 * @param {{salt?:string, config?:object, disallow?:string[], endpointCosts?:{prefix:string,usd:number}[],
 *   convertedPaths?:string[], verifyBot?:(ip:string, ua:string)=>string|null}} [opts]
 */
export function analyzeLines(lines, opts = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...(opts.config ?? {}) };
  const { salt = 'audit', disallow = [], endpointCosts = [], convertedPaths = [] } = opts;
  const subs = new Map();
  let total = 0, skipped = 0, from = Infinity, to = -Infinity;
  for (const line of lines) {
    total++;
    const e = parseLine(line);
    if (!e) { skipped++; continue; }
    from = Math.min(from, e.ts); to = Math.max(to, e.ts);
    const id = hashId(salt, e.key ?? `${e.ip}|${e.ua}`);
    let s = subs.get(id);
    if (!s) {
      s = { kind: e.key ? 'api_key' : 'session', id, ua: uaClass(e.ua), verified: opts.verifyBot?.(e.ip, e.ua) ?? null,
        requests: 0, bytes: 0, cost: 0, minutes: new Map(), seen: new Set(), repeats: 0, robots: 0, errors: 0, converted: false, rpm: 0 };
      subs.set(id, s);
    }
    s.requests++; s.bytes += e.bytes;
    const endpoint = endpointCosts.find((x) => e.path.startsWith(x.prefix));
    s.cost += attributeCost({ cpu_s: e.rt, bytes: e.bytes, direct_usd: endpoint?.usd ?? 0 }, cfg);
    const minute = Math.floor(e.ts / 60000), n = (s.minutes.get(minute) ?? 0) + 1;
    s.minutes.set(minute, n); s.rpm = Math.max(s.rpm, n);
    const seenKey = `${e.path}|${e.bytes}`;
    if (e.status === 304 || s.seen.has(seenKey)) s.repeats++; else s.seen.add(seenKey);
    if (disallow.some((p) => e.path.startsWith(p))) s.robots++;
    if (e.status >= 400 && e.status !== 401 && e.status !== 429) s.errors++; // 401 and 429 are our own or auth replies
    if (convertedPaths.some((p) => e.path.startsWith(p))) s.converted = true;
  }

  const report = {
    lines: total, skipped, window: total > skipped ? { from: new Date(from).toISOString(), to: new Date(to).toISOString() } : null,
    subjects: subs.size, totals: { requests: 0, bytes: 0, cost_usd: 0 }, by_class: {}, by_decision: {},
    estimated_savings_usd: 0, good_traffic: { subjects_converted: 0, cost_usd: 0 }, top_subjects: [],
  };
  const rows = [];
  for (const s of subs.values()) {
    const verdict = decide({
      subject: { kind: s.kind, id: s.id }, mode: 'shadow',
      context: { surface: s.kind === 'api_key' ? 'api' : 'content' },
      behavior: { rpm: s.rpm, robots_violations: s.robots, refetch_unchanged: s.requests >= 20 ? s.repeats / s.requests : 0,
        error_ratio: s.requests >= 20 ? s.errors / s.requests : 0, ua: s.ua },
      signals: s.verified ? [{ type: 'bot.verified', value: s.verified, confidence: 0.95, freshness_s: 0, provenance: 'log_audit.verify_bot' }] : [],
      cost: { usd: s.cost, budget_usd: cfg.budgetUsd },
    }, cfg);
    const saved = savedUsd(verdict, s, cfg);
    const cls = (report.by_class[verdict.class] ??= { subjects: 0, requests: 0, cost_usd: 0 });
    cls.subjects++; cls.requests += s.requests; cls.cost_usd += s.cost;
    report.by_decision[verdict.decision] = (report.by_decision[verdict.decision] ?? 0) + 1;
    report.totals.requests += s.requests; report.totals.bytes += s.bytes; report.totals.cost_usd += s.cost;
    report.estimated_savings_usd += saved;
    if (s.converted) { report.good_traffic.subjects_converted++; report.good_traffic.cost_usd += s.cost; }
    rows.push({ subject: `${s.kind}:${s.id}`, class: verdict.class, decision: verdict.decision, reasons: verdict.reasons,
      requests: s.requests, peak_rpm: s.rpm, cost_usd: s.cost, saved_usd: saved });
  }
  report.top_subjects = rows.sort((a, b) => b.cost_usd - a.cost_usd).slice(0, opts.top ?? 10);
  return report;
}

export async function analyzeFile(path, opts = {}) {
  const lines = [];
  for await (const line of createInterface({ input: createReadStream(path), crlfDelay: Infinity })) lines.push(line);
  return analyzeLines(lines, opts);
}

const usd = (x) => `$${x.toFixed(2)}`;

/** One-page text report of the bot load and cost audit. */
export function renderAudit(report) {
  const out = [`Bot load and cost audit (shadow mode, nothing enforced)`,
    `Lines ${report.lines} (skipped ${report.skipped}), subjects ${report.subjects}, window ${report.window?.from} .. ${report.window?.to}`,
    `Total attributed cost ${usd(report.totals.cost_usd)}; estimated savings ${usd(report.estimated_savings_usd)}`,
    `Good traffic converted: ${report.good_traffic.subjects_converted} subjects, ${usd(report.good_traffic.cost_usd)} cost`, '', 'By class:'];
  for (const [name, c] of Object.entries(report.by_class).sort((a, b) => b[1].cost_usd - a[1].cost_usd)) {
    out.push(`  ${name.padEnd(22)} subjects ${String(c.subjects).padStart(5)}  requests ${String(c.requests).padStart(7)}  cost ${usd(c.cost_usd)}`);
  }
  out.push('', 'Top subjects by cost:');
  for (const r of report.top_subjects) {
    out.push(`  ${r.subject.slice(0, 20).padEnd(20)} ${r.class.padEnd(22)} ${r.decision.padEnd(8)} ${usd(r.cost_usd).padStart(9)}  ${r.reasons.slice(0, 3).join(',')}`);
  }
  return out.join('\n');
}
