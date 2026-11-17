// @ts-check
/** Scoring core: config, signal normalisation, evidence scores, cost attribution. Zero dependencies. */
import { createHmac } from 'node:crypto';

export const SPEC_VERSION = '1.2.0';
export const CLASSES = ['likely_farm', 'legitimate_heavy_user', 'legitimate_user', 'reseller', 'delegated_agent',
  'assistive_tool', 'search_engine', 'declared_crawler', 'suspected_scraper', 'inconclusive'];
export const DECISIONS = ['allow', 'step_up', 'slow', 'limit', 'block'];

const num = (env, key, dflt) => {
  const v = Number(env[key]);
  return env[key] === undefined || env[key] === '' || Number.isNaN(v) ? dflt : v;
};

/** Build config from env vars (12-factor). Every key and default is documented in docs/MANUAL-OUTLINE.md. */
export function loadConfig(env = {}, overrides = {}) {
  return {
    mode: env.AG_MODE === 'enforce' ? 'enforce' : 'shadow',
    failMode: env.AG_FAIL_MODE === 'closed' ? 'closed' : 'open',
    farmBlock: num(env, 'AG_FARM_BLOCK', 0.85),
    farmStepUp: num(env, 'AG_FARM_STEP_UP', 0.5),
    scraperSlow: num(env, 'AG_SCRAPER_SLOW', 0.6),
    scraperWatch: num(env, 'AG_SCRAPER_WATCH', 0.35),
    maxSignalAgeS: num(env, 'AG_SIGNAL_MAX_AGE_S', 86400),
    minSignalConfidence: num(env, 'AG_SIGNAL_MIN_CONFIDENCE', 0.3),
    rpmHigh: num(env, 'AG_RPM_HIGH', 120),
    rpmVeryHigh: num(env, 'AG_RPM_VERY_HIGH', 600),
    errorRatio: num(env, 'AG_ERROR_RATIO', 0.1),
    fanoutReseller: num(env, 'AG_KEY_FANOUT', 25),
    agentRpm: num(env, 'AG_AGENT_RPM', 60),
    crawlerRpm: num(env, 'AG_CRAWLER_RPM', 60),
    slowRpm: num(env, 'AG_SLOW_RPM', 30),
    retryAfterS: num(env, 'AG_RETRY_AFTER_S', 60),
    budgetUsd: num(env, 'AG_BUDGET_USD', 5),
    windowS: num(env, 'AG_BUDGET_WINDOW_S', 86400),
    costPerCpuS: num(env, 'AG_COST_PER_CPU_S', 0.00005),
    costPerGb: num(env, 'AG_COST_PER_GB', 0.08),
    costPerDbS: num(env, 'AG_COST_PER_DB_S', 0.0001),
    appealSlaHours: num(env, 'AG_APPEAL_SLA_HOURS', 24),
    ...overrides,
  };
}
export const DEFAULT_CONFIG = Object.freeze(loadConfig());

/** Keyed hash for identifiers. Raw IPs, emails, keys and card fingerprints never reach the store. */
export const hashId = (salt, raw) => createHmac('sha256', String(salt)).update(String(raw)).digest('hex').slice(0, 32);
export const subjectKey = (s) => `${s.kind}:${s.id}`;
const clamp = (x) => Math.round(Math.max(0, Math.min(1, x)) * 1e4) / 1e4;

/** Dollars attributed to a unit of usage: compute, bandwidth, database time, plus direct endpoint cost. */
export function attributeCost(u = {}, cfg = DEFAULT_CONFIG) {
  return (u.cpu_s ?? 0) * cfg.costPerCpuS + ((u.bytes ?? 0) / 1e9) * cfg.costPerGb
    + (u.db_s ?? 0) * cfg.costPerDbS + (u.direct_usd ?? 0);
}

const MAX_AGE_S = { 'agent.credential': 300 };

/** Keep the most confident fresh signal per type. Stale or weak signals are dropped and noted, never fatal. */
export function normalizeSignals(signals = [], cfg = DEFAULT_CONFIG) {
  const byType = {}, notes = [];
  for (const s of signals) {
    if (!s || typeof s.type !== 'string') continue;
    const confidence = s.confidence ?? 0.5;
    if ((s.freshness_s ?? 0) > (MAX_AGE_S[s.type] ?? cfg.maxSignalAgeS)) { notes.push('STALE_SIGNAL_IGNORED'); continue; }
    if (confidence < cfg.minSignalConfidence) { notes.push('LOW_CONFIDENCE_SIGNAL_IGNORED'); continue; }
    if (!byType[s.type] || byType[s.type].confidence < confidence) byType[s.type] = { ...s, confidence };
  }
  return { byType, notes };
}

/**
 * Evidence scores for one subject. Weights are part of the decision spec (docs/DECISION-SPEC.md).
 * @param {any} input assessment request  @param {any} cfg
 */
export function score(input, cfg = DEFAULT_CONFIG) {
  const b = input.behavior ?? {};
  const { byType: sig, notes } = normalizeSignals(input.signals, cfg);
  const reasons = [...notes];
  const add = (cond, code, weight) => { if (!cond) return 0; reasons.push(code); return weight; };
  const dc = b.device_cluster ?? 0, pc = b.payment_cluster ?? 0, ipc = b.ip_cluster ?? 0, rpm = b.rpm ?? 0;
  const risk = sig['risk.multi_account'], live = sig['human.liveness'], proxy = sig['network.proxy'];
  const strongLink = dc >= 3 || pc >= 3 || (!!risk && risk.value >= 0.8 && risk.confidence >= 0.8);

  let legit = add(b.paying === true, 'PAYING_CUSTOMER', 0.5) + add((b.tenure_days ?? 0) >= 90, 'ESTABLISHED_TENURE', 0.2);
  const contact = (b.email_confirmed ? 0.1 : 0) + (b.passkey ? 0.2 : 0) + (b.card_on_file && pc < 3 ? 0.2 : 0);
  legit += add(contact > 0, 'VERIFIED_CONTACT', contact);
  legit += add(live?.value === 'pass', 'HUMAN_CHECK_PASSED', 0.3 * (live?.confidence ?? 0));
  legit = clamp(legit);

  let farm = add(dc >= 3, 'DEVICE_CLUSTER', dc >= 10 ? 0.6 : 0.4) + add(pc >= 3, 'PAYMENT_CLUSTER', pc >= 5 ? 0.5 : 0.3);
  farm += add(!!risk && risk.value >= 0.5, 'PROVIDER_MULTI_ACCOUNT_RISK', 0.5 * (risk?.value ?? 0) * (risk?.confidence ?? 0));
  farm += add((b.signups_per_hour ?? 0) >= 10, 'SIGNUP_VELOCITY', 0.2) + add(!!b.disposable_email, 'DISPOSABLE_EMAIL', 0.15);
  // A shared IP alone is weak evidence; a known shared network (campus, office, CGNAT) removes it entirely.
  if (ipc >= 20) farm += sig['network.shared_env'] ? add(true, 'SHARED_NETWORK_DISCOUNT', 0) : add(true, 'IP_CLUSTER_WEAK', 0.15);
  farm = clamp(farm - 0.5 * legit);
  if (!strongLink) farm = Math.min(farm, 0.7);

  let scraper = 0;
  if ((input.context?.surface ?? 'api') === 'content') {
    scraper += add(rpm >= cfg.rpmHigh, 'HIGH_REQUEST_RATE', rpm >= cfg.rpmVeryHigh ? 0.5 : 0.3);
    scraper += add((b.robots_violations ?? 0) > 0, 'ROBOTS_VIOLATION', 0.3);
    scraper += add((b.refetch_unchanged ?? 0) >= 0.5, 'UNCHANGED_REFETCH', 0.2);
    // Fast and failing: probing for pages that do not exist. Counted only together with a high request rate.
    scraper += add(rpm >= cfg.rpmHigh && (b.error_ratio ?? 0) >= cfg.errorRatio, 'ERROR_RESPONSE_RATIO', 0.2);
    // Pattern, frequency and time-window evidence (computed from logs or supplied by the caller).
    scraper += add(b.ua === 'browser' && (b.page_requests ?? 0) >= 20 && (b.asset_ratio ?? 1) < 0.02, 'BROWSER_WITHOUT_ASSETS', 0.3);
    const bulk = (b.page_requests ?? 0) >= 1000; // regular timing only counts at volume: hourly pollers are normal
    scraper += add(bulk && (b.interval_cv ?? 1) < 0.1, 'EVEN_SPACING', 0.2) + add((b.sequential_ratio ?? 0) >= 0.5, 'PATH_ENUMERATION', 0.2);
    scraper += add(bulk && (b.active_hours_ratio ?? 0) >= 0.85, 'ROUND_THE_CLOCK', 0.15) + add((b.trap_hits ?? 0) > 0, 'TRAP_LINK', 0.5);
    scraper += add(!!proxy, 'PROXY_NETWORK', (proxy?.value === 'residential' ? 0.2 : 0.15) * (proxy?.confidence ?? 0));
    scraper += add(b.ua === 'library' || b.ua === 'empty', 'NON_BROWSER_CLIENT', 0.1);
    scraper = clamp(scraper - 0.5 * legit);
  }

  const costUsd = input.cost?.usd ?? 0, budgetUsd = input.cost?.budget_usd ?? cfg.budgetUsd;
  const costRatio = budgetUsd > 0 ? Math.round((costUsd / budgetUsd) * 1e4) / 1e4 : 0;
  if (costRatio >= 1) reasons.push('COST_OVER_BUDGET'); else if (costRatio >= 0.8) reasons.push('COST_NEAR_BUDGET');
  return { sig, reasons, legit, farm, scraper, strongLink, costUsd, budgetUsd, costRatio };
}
