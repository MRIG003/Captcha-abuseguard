#!/usr/bin/env node
// Validation on public data. Downloads the datasets listed in SOURCES into validation/data (git-ignored), runs the
// unmodified engine on them and writes validation/results.json. Usage: node validation/run.js
// What each experiment can and cannot show is written up in docs/VALIDATION.md.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { analyzeLines, parseLine, uaClass, decide, createMemoryStore, hashId, DEFAULT_CONFIG } from '../src/index.js';

const DIR = new URL('./data/', import.meta.url);
const RAW = 'https://raw.githubusercontent.com';
export const SOURCES = {
  'nginx_logs': `${RAW}/elastic/examples/master/Common%20Data%20Formats/nginx_logs/nginx_logs`,
  'apache_logs': `${RAW}/elastic/examples/master/Common%20Data%20Formats/apache_logs/apache_logs`,
  'crawlers.json': `${RAW}/monperrus/crawler-user-agents/master/crawler-user-agents.json`,
  'browsers.json': `${RAW}/microlinkhq/top-user-agents/master/src/index.json`,
  'ai-robots.json': `${RAW}/ai-robots-txt/ai.robots.txt/main/robots.json`,
  'ocatak_acunetix.txt': `${RAW}/ocatak/apache-http-logs/master/acunetix.txt`,
  'ocatak_netsparker.txt': `${RAW}/ocatak/apache-http-logs/master/netsparker.txt`,
  'ocatak_w3af.txt': `${RAW}/ocatak/apache-http-logs/master/w3af.txt`,
  'azure_conv.csv': `${RAW}/Azure/AzurePublicDataset/master/data/AzureLLMInferenceTrace_conv.csv`,
  'azure_code.csv': `${RAW}/Azure/AzurePublicDataset/master/data/AzureLLMInferenceTrace_code.csv`,
  'burstgpt_1.csv': `${RAW}/HPMLL/BurstGPT/main/data/BurstGPT_1.csv`,
};

async function load(name) {
  const file = new URL(name, DIR);
  if (!existsSync(file)) {
    mkdirSync(DIR, { recursive: true });
    const res = await fetch(SOURCES[name]);
    if (!res.ok) throw new Error(`download failed for ${name}: ${res.status}`);
    writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  }
  return readFileSync(file, 'utf8');
}
const NEW_SIGNALS = ['ERROR_RESPONSE_RATIO', 'BROWSER_WITHOUT_ASSETS', 'EVEN_SPACING', 'PATH_ENUMERATION', 'ROUND_THE_CLOCK', 'TRAP_LINK'];
const pct = (num, den) => (den ? Math.round((num / den) * 10000) / 100 : null);
const round = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// ---------------------------------------------------------------------------------------------------------------
// E1. User-agent classification against public crawler and browser lists.
async function e1() {
  const crawlers = JSON.parse(await load('crawlers.json'));
  const instances = crawlers.flatMap((c) => c.instances ?? []);
  const tally = (list) => list.reduce((acc, ua) => { const k = uaClass(ua); acc[k] = (acc[k] ?? 0) + 1; return acc; }, {});
  const crawlerClasses = tally(instances);
  const browsers = JSON.parse(await load('browsers.json'));
  const browserClasses = tally(browsers);
  const aiNames = Object.keys(JSON.parse(await load('ai-robots.json'))).filter((name) => !name.startsWith('__'));
  const aiClasses = tally(aiNames);
  const automated = (c) => (c.declared_bot ?? 0) + (c.declared_agent ?? 0) + (c.library ?? 0);
  return {
    crawler_user_agents: { n: instances.length, classes: crawlerClasses,
      recognised_as_declared_bot_pct: pct(crawlerClasses.declared_bot ?? 0, instances.length),
      recognised_as_any_automation_pct: pct(automated(crawlerClasses), instances.length),
      mistaken_for_browser_pct: pct(crawlerClasses.browser ?? 0, instances.length) },
    real_browser_user_agents: { n: browsers.length, classes: browserClasses, classified_browser_pct: pct(browserClasses.browser ?? 0, browsers.length) },
    ai_crawler_names: { n: aiNames.length, classes: aiClasses, recognised_as_any_automation_pct: pct(automated(aiClasses), aiNames.length),
      missed_examples: aiNames.filter((n) => uaClass(n) === 'browser').slice(0, 12) },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// E2. Real nginx traffic (Elastic example logs, May-June 2015, a package download server). No ground truth:
// the public crawler list gives a weak label for declared crawlers.
async function e2(file = 'nginx_logs') {
  const lines = (await load(file)).split('\n').filter(Boolean);
  const crawlerRe = JSON.parse(await load('crawlers.json')).map((c) => { try { return new RegExp(c.pattern, 'i'); } catch { return null; } }).filter(Boolean);
  const isListed = (ua) => crawlerRe.some((re) => re.test(ua));
  const t0 = performance.now();
  const report = analyzeLines(lines, { salt: 'validation', top: 100000 });
  const ms = performance.now() - t0;
  // Re-derive per-subject user agents with the same hashing as the analyzer, to attach weak labels.
  const uaBySubject = new Map();
  for (const line of lines) { const e = parseLine(line); if (e) uaBySubject.set(`session:${hashId('validation', `${e.ip}|${e.ua}`)}`, e.ua); }
  const groups = {};
  for (const row of report.top_subjects) {
    const ua = uaBySubject.get(row.subject) ?? '', klass = uaClass(ua);
    const group = isListed(ua) ? 'listed_crawler' : klass === 'browser' ? 'browser_ua' : klass === 'declared_bot' ? 'other_declared_bot' : /apt-http|urlgrabber|yum|chef|libwww|wget|curl/i.test(ua) ? 'package_or_cli_client' : 'other_automation';
    const g = (groups[group] ??= { subjects: 0, requests: 0, allow: 0, step_up: 0, slow: 0, limit: 0, block: 0 });
    g.subjects++; g.requests += row.requests; g[row.decision]++;
  }
  for (const g of Object.values(groups)) g.not_allowed_pct = pct(g.subjects - g.allow, g.subjects);
  const flagged = report.top_subjects.filter((r) => r.decision !== 'allow').slice(0, 8)
    .map((r) => ({ ua: (uaBySubject.get(r.subject) ?? '').slice(0, 60), class: r.class, decision: r.decision, requests: r.requests, peak_rpm: r.peak_rpm, reasons: r.reasons.slice(0, 4) }));
  const fired = {};
  for (const row of report.top_subjects) for (const code of row.reasons) if (NEW_SIGNALS.includes(code)) fired[code] = (fired[code] ?? 0) + 1;
  return { lines: report.lines, skipped: report.skipped, subjects: report.subjects, window: report.window, analyse_ms: Math.round(ms),
    by_class: report.by_class, by_decision: report.by_decision, groups, new_signals_fired_on_subjects: fired, examples_not_allowed: flagged };
}

// ---------------------------------------------------------------------------------------------------------------
// E3. Labelled vulnerability-scanner logs (ocatak/apache-http-logs: Acunetix, Netsparker, w3af), alone and mixed
// into the real nginx traffic. Ground truth: every scanner request is abusive automation.
async function e3() {
  const clean = (text) => text.split('\n').map((l) => l.trim().replace(/^"|"$/g, '')).filter(Boolean);
  const scanners = {};
  const mixed = (await load('nginx_logs')).split('\n').filter(Boolean).map((line) => ({ line, abusive: false }));
  for (const tool of ['acunetix', 'netsparker', 'w3af']) {
    const lines = clean(await load(`ocatak_${tool}.txt`));
    const report = analyzeLines(lines, { salt: 'validation', top: 1000 });
    const caught = report.top_subjects.filter((r) => r.decision !== 'allow');
    const errors = lines.map(parseLine).filter(Boolean);
    scanners[tool] = { lines: report.lines, skipped: report.skipped, subjects: report.subjects,
      requests_from_flagged_subjects_pct: pct(caught.reduce((a, r) => a + r.requests, 0), report.lines - report.skipped),
      error_status_pct: pct(errors.filter((e) => e.status >= 400).length, errors.length),
      subjects_detail: report.top_subjects.slice(0, 4).map((r) => ({ class: r.class, decision: r.decision, requests: r.requests, peak_rpm: r.peak_rpm, reasons: r.reasons.filter((c) => c !== 'NO_EXTERNAL_SIGNALS') })) };
    // Give each scanner a distinct source address so it cannot collide with a real client in the mixed set.
    for (const line of lines) mixed.push({ line: line.replace(/^\S+/, `scanner-${tool}`), abusive: true });
  }
  const report = analyzeLines(mixed.map((m) => m.line), { salt: 'validation', top: 100000 });
  const truth = new Map();
  for (const m of mixed) { const e = parseLine(m.line); if (e) truth.set(`session:${hashId('validation', `${e.ip}|${e.ua}`)}`, m.abusive); }
  let tp = 0, fp = 0, fn = 0, tn = 0, tpReq = 0, fpReq = 0, fnReq = 0;
  for (const r of report.top_subjects) {
    const abusive = truth.get(r.subject) === true, flagged = r.decision !== 'allow';
    if (abusive && flagged) { tp++; tpReq += r.requests; } else if (abusive) { fn++; fnReq += r.requests; } else if (flagged) { fp++; fpReq += r.requests; } else tn++;
  }
  return { scanners, mixed_with_real_traffic: {
    subjects: { scanner_flagged: tp, scanner_missed: fn, real_traffic_flagged: fp, real_traffic_allowed: tn },
    scanner_request_recall_pct: pct(tpReq, tpReq + fnReq), request_precision_pct: pct(tpReq, tpReq + fpReq),
    real_traffic_subjects_flagged_pct: pct(fp, fp + tn) } };
}

// ---------------------------------------------------------------------------------------------------------------
// E4. Real LLM usage traces (token counts per request) priced at an ASSUMED rate, then a semi-synthetic farm:
// real request costs, invented identities. Tests the budget arithmetic through the real store and engine.
const PRICE = { inPerM: 3, outPerM: 15 }; // ASSUMED dollars per million tokens; change here to re-run
const costOf = (inTok, outTok) => (inTok * PRICE.inPerM + outTok * PRICE.outPerM) / 1e6;
async function e4() {
  const dist = {};
  for (const name of ['azure_conv.csv', 'azure_code.csv']) {
    const costs = (await load(name)).split('\n').slice(1).filter(Boolean).map((l) => { const [, a, b] = l.split(','); return costOf(+a, +b); }).sort((x, y) => x - y);
    dist[name] = { requests: costs.length, mean_usd: round(costs.reduce((a, b) => a + b, 0) / costs.length, 5), p50_usd: round(quantile(costs, 0.5), 5), p99_usd: round(quantile(costs, 0.99), 5), max_usd: round(costs.at(-1), 5) };
  }
  // First 24 hours of BurstGPT (timestamps are seconds from trace start).
  const day = [];
  for (const l of (await load('burstgpt_1.csv')).split('\n').slice(1)) {
    const [ts, , inTok, outTok] = l.split(',');
    if (+ts >= 86400) break;
    if (inTok) day.push(costOf(+inTok, +outTok));
  }
  const sorted = [...day].sort((x, y) => x - y), totalUsd = day.reduce((a, b) => a + b, 0);
  dist['burstgpt_1.csv (first 24 h)'] = { requests: day.length, mean_usd: round(totalUsd / day.length, 5), p50_usd: round(quantile(sorted, 0.5), 5), p99_usd: round(quantile(sorted, 0.99), 5), max_usd: round(sorted.at(-1), 5), total_usd: round(totalUsd) };

  // Identities are invented: 80% of requests go to 2,000 ordinary users (Zipf activity), 20% to 10 farms of 40
  // accounts that share one device each and spread their requests evenly to stay under a per-account budget.
  const r = rng(7), USERS = 2000, FARMS = 10, FARM_SIZE = 40;
  const zipf = Array.from({ length: USERS }, (_, i) => 1 / (i + 1) ** 0.9), zsum = zipf.reduce((a, b) => a + b, 0);
  const cdf = []; zipf.reduce((acc, w, i) => (cdf[i] = acc + w / zsum), 0);
  const pickUser = () => { const x = r(); let lo = 0, hi = USERS - 1; while (lo < hi) { const mid = (lo + hi) >> 1; if (cdf[mid] < x) lo = mid + 1; else hi = mid; } return lo; };
  const spend = new Map(), farmOf = new Map(), next = Array(FARMS).fill(0);
  for (const usd of day) {
    let id;
    if (r() < 0.2) { const f = Math.floor(r() * FARMS); id = `farm${f}-acct${next[f]++ % FARM_SIZE}`; farmOf.set(id, f); } else id = `user${pickUser()}`;
    spend.set(id, (spend.get(id) ?? 0) + usd);
  }
  const legit = [...spend].filter(([id]) => !farmOf.has(id)).map(([, v]) => v).sort((x, y) => x - y);
  const out = { identities: { ordinary_users_active: legit.length, farms: FARMS, accounts_per_farm: FARM_SIZE }, budgets: [] };
  for (const q of [0.9, 0.95, 0.99]) {
    const budget = quantile(legit, q), store = createMemoryStore(), tenant = 't', win = 0;
    for (const [id, usd] of spend) {
      const subject = { kind: 'account', id };
      await store.addUsage(tenant, subject, win, { requests: 1, cost_usd: usd });
      if (farmOf.has(id)) await store.linkAttribute(tenant, subject, 'device', `device-farm${farmOf.get(id)}`);
    }
    const res = { farmUsd: 0, perKeyCaught: 0, clusterCaught: 0, legitLimited: 0, legitLimitedPerKey: 0, farmAccounts: 0, farmFlaggedPerKey: 0, farmFlaggedCluster: 0 };
    for (const [id, usd] of spend) {
      const subject = { kind: 'account', id }, farm = farmOf.has(id);
      const perKey = decide({ subject, context: { surface: 'api' }, cost: { usd, budget_usd: budget } });
      const cluster = await store.clusterUsage(tenant, subject, win, ['device']);
      const size = await store.clusterSize(tenant, subject, 'device');
      const ours = decide({ subject, context: { surface: 'api' }, behavior: { device_cluster: size }, cost: { usd: cluster.cost_usd, budget_usd: budget } });
      if (farm) {
        res.farmUsd += usd; res.farmAccounts++;
        if (perKey.decision !== 'allow') { res.perKeyCaught += usd; res.farmFlaggedPerKey++; }
        if (ours.decision !== 'allow') { res.clusterCaught += usd; res.farmFlaggedCluster++; }
      } else { if (ours.decision !== 'allow') res.legitLimited++; if (perKey.decision !== 'allow') res.legitLimitedPerKey++; }
    }
    out.budgets.push({ budget_rule: `p${q * 100} of ordinary users' daily spend`, budget_usd: round(budget, 4), farm_cost_usd: round(res.farmUsd),
      farm_accounts: res.farmAccounts, farm_accounts_over_own_budget: res.farmFlaggedPerKey, farm_accounts_flagged_cluster: res.farmFlaggedCluster,
      farm_cost_caught_per_identifier_pct: pct(res.perKeyCaught, res.farmUsd), farm_cost_caught_cluster_pct: pct(res.clusterCaught, res.farmUsd),
      ordinary_users_limited_per_identifier_pct: pct(res.legitLimitedPerKey, legit.length), ordinary_users_limited_cluster_pct: pct(res.legitLimited, legit.length) });
  }
  return { assumed_price_usd_per_million_tokens: PRICE, per_request_cost: dist, semi_synthetic_farm: out };
}

const results = { generated_at: new Date().toISOString(), engine_defaults: { rpmHigh: DEFAULT_CONFIG.rpmHigh, scraperSlow: DEFAULT_CONFIG.scraperSlow, budgetUsd: DEFAULT_CONFIG.budgetUsd },
  e1_user_agent_classification: await e1(), e2_real_nginx_traffic: await e2(), e2b_real_website_traffic: await e2('apache_logs'), e3_labelled_scanners: await e3(), e4_llm_cost_traces: await e4() };
writeFileSync(new URL('./results.json', import.meta.url), `${JSON.stringify(results, null, 2)}\n`);
console.log(JSON.stringify(results, null, 1));
