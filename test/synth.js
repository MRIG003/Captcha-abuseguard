// Synthetic-data generator for proof tests and the demo. Seeded, so every run is identical.
// Synthetic populations are assumptions, not measurements: see docs/GAP-ANALYSIS.md "Proof".

export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sig = (type, value, confidence, provenance) => ({ type, value, confidence, freshness_s: 30, provenance });
const BUDGET = 5;

/**
 * @returns {{input: any, truth: {group: string, abusive: boolean, paying: boolean, sharedIp: boolean, ownCostUsd: number}}[]}
 */
export function genSubjects(seed = 1, n = 10000) {
  const r = rng(seed), between = (lo, hi) => lo + r() * (hi - lo), int = (lo, hi) => Math.floor(between(lo, hi + 1));
  const out = [];
  const push = (group, abusive, input, extra = {}) => out.push({
    input: { mode: 'enforce', ...input },
    truth: { group, abusive, paying: input.behavior?.paying === true, sharedIp: false, ownCostUsd: input.cost?.usd ?? 0, ...extra },
  });
  const sharedIp = (behavior, signals) => {
    if (r() >= 0.15) return false;
    behavior.ip_cluster = int(50, 5000);
    if (r() < 0.2) behavior.signups_per_hour = int(10, 40);
    if (r() < 0.5) signals.push(sig('network.shared_env', ['campus', 'office', 'cgnat'][int(0, 2)], 0.85, 'ip_intel'));
    return true;
  };

  while (out.length < n) {
    const roll = r(), id = `s${out.length}`;
    if (roll < 0.76) { // legitimate free users
      const signals = [], d = r();
      const behavior = { device_cluster: d < 0.92 ? 1 : d < 0.98 ? int(2, 3) : int(4, 6), email_confirmed: r() < 0.8, disposable_email: r() < 0.03 };
      const shared = sharedIp(behavior, signals);
      if (r() < 0.01) signals.push(sig('risk.multi_account', between(0.5, 0.8), 0.6, 'provider_x'));
      const usd = r() < 0.97 ? between(0, 4) : between(5, 15);
      push('legit_free', false, { subject: { kind: 'account', id }, context: { surface: 'api', endpoint_class: 'expensive' }, behavior, signals, cost: { usd, budget_usd: BUDGET } }, { sharedIp: shared });
    } else if (roll < 0.88) { // legitimate paying users, including teams on shared machines
      const signals = [];
      const behavior = { paying: true, tenure_days: int(0, 900), card_on_file: r() < 0.9, email_confirmed: true,
        device_cluster: r() < 0.8 ? int(1, 2) : int(3, 8), rpm: int(0, 500), disposable_email: r() < 0.01 };
      const shared = sharedIp(behavior, signals);
      if (r() < 0.01) signals.push(sig('risk.multi_account', between(0.8, 0.95), 0.85, 'provider_x'));
      push('legit_paying', false, { subject: { kind: 'account', id }, context: { surface: 'api', endpoint_class: 'expensive' }, behavior, signals, cost: { usd: between(5, 200), budget_usd: 50 } }, { sharedIp: shared });
    } else if (roll < 0.90) { // farm: every member stays under the per-key budget on purpose
      const size = int(5, 200), members = Math.min(size, n - out.length, int(1, 12));
      const visible = r() < 0.7, providerSees = r() < 0.5, sharedCard = r() < 0.3;
      const own = Array.from({ length: members }, () => between(2, 4.5));
      const clusterUsd = own.reduce((a, b) => a + b, 0) * (size / members);
      for (let i = 0; i < members; i++) {
        const behavior = { device_cluster: visible ? size : int(1, 2), disposable_email: r() < 0.6, signups_per_hour: r() < 0.7 ? int(10, 60) : int(0, 5), email_confirmed: r() < 0.5 };
        if (sharedCard) { behavior.payment_cluster = size; behavior.card_on_file = true; }
        const signals = providerSees ? [sig('risk.multi_account', between(0.85, 0.99), 0.85, 'provider_x')] : [];
        const linked = visible || sharedCard; // cost is aggregated only when the store can link the members
        push('farm', true, { subject: { kind: 'account', id: `${id}_${i}` }, context: { surface: 'api', endpoint_class: 'expensive' }, behavior, signals, cost: { usd: linked ? clusterUsd : own[i], budget_usd: BUDGET } }, { ownCostUsd: own[i] });
      }
    } else if (roll < 0.95) { // scrapers on content
      const behavior = { rpm: int(150, 3000), robots_violations: r() < 0.6 ? int(1, 500) : 0, refetch_unchanged: between(0, 0.9), ua: r() < 0.6 ? 'library' : 'browser' };
      const signals = r() < 0.4 ? [sig('network.proxy', 'residential', 0.8, 'ip_intel')] : [];
      push('scraper', true, { subject: { kind: 'session', id }, context: { surface: 'content' }, behavior, signals, cost: { usd: between(0.5, 30), budget_usd: BUDGET } });
    } else if (roll < 0.97) { // verified delegated agents
      const signals = [sig('agent.credential', { scheme: 'web-bot-auth', agent_id: 'example-agent', verified: true, user_bound: true }, 0.95, 'adapter.web_bot_auth')];
      push('agent', false, { subject: { kind: 'account', id }, context: { surface: 'api' }, behavior: { rpm: int(1, 50), ua: 'declared_agent' }, signals, cost: { usd: between(0, 4), budget_usd: BUDGET } });
    } else if (roll < 0.985) { // assistive technology that looks automated
      const signals = [sig('assistive.tool', true, 0.8, 'self_declared')];
      push('assistive', false, { subject: { kind: 'session', id }, context: { surface: 'content' }, behavior: { rpm: int(20, 250), refetch_unchanged: between(0, 0.7), ua: r() < 0.5 ? 'library' : 'browser' }, signals, cost: { usd: between(0, 4), budget_usd: BUDGET } });
    } else { // verified search engines
      push('search_engine', false, { subject: { kind: 'session', id }, context: { surface: 'content' }, behavior: { rpm: int(100, 2000), ua: 'declared_bot' }, signals: [sig('bot.verified', 'search_engine', 0.99, 'rdns')], cost: { usd: between(0, 20), budget_usd: BUDGET } });
    }
  }
  return out;
}

const two = (x) => String(x).padStart(2, '0');

/** Synthetic combined-format access log: readers, a verified search engine, a polite bot, a scraper, an expensive-endpoint abuser. */
export function genLogs(seed = 1, minutes = 30) {
  const r = rng(seed), lines = [], start = Date.UTC(2026, 10, 1, 12, 0, 0);
  const line = (ts, ip, path, status, bytes, ua, rt) => {
    const d = new Date(ts);
    lines.push(`${ip} - - [${two(d.getUTCDate())}/Nov/2026:${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())} +0000] "GET ${path} HTTP/1.1" ${status} ${bytes} "-" "${ua}" ${rt.toFixed(3)}`);
  };
  const browser = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36';
  for (let m = 0; m < minutes; m++) {
    const t = start + m * 60000;
    for (let u = 0; u < 120; u++) { // readers: ~1 request a minute each
      if (r() < 0.5) line(t + r() * 59000, `10.0.${u >> 4}.${u}`, `/articles/${Math.floor(r() * 5000)}`, 200, 30000 + Math.floor(r() * 40000), browser, 0.05 + r() * 0.1);
      if (u < 6 && m === minutes - 1) line(t + 1000, `10.0.${u >> 4}.${u}`, '/checkout/complete', 200, 2000, browser, 0.2);
    }
    for (let i = 0; i < 300; i++) line(t + i * 190, '66.249.66.1', `/articles/${Math.floor(r() * 5000)}`, 200, 40000, 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', 0.05);
    for (let i = 0; i < 8; i++) line(t + i * 7000, '203.0.113.9', `/articles/${m * 8 + i}`, 200, 40000, 'ExampleArchiveBot/1.0 (+https://example.org/bot)', 0.05);
    for (let i = 0; i < 900; i++) { // scraper: ignores robots.txt, re-fetches the same 200 pages
      const path = i % 5 === 0 ? `/private/export/${i % 40}` : `/articles/${i % 200}`;
      line(t + i * 66, '198.51.100.23', path, 200, 45000, 'python-requests/2.32', 0.08);
    }
    for (let i = 0; i < 20; i++) line(t + i * 2900, '198.51.100.77', '/api/generate', 200, 8000, 'curl/8.5', 2.5); // expensive endpoint
  }
  lines.push('this line is not a log entry');
  return lines;
}

export const demoAuditOptions = {
  salt: 'demo-salt', disallow: ['/private/'], convertedPaths: ['/checkout/complete'],
  endpointCosts: [{ prefix: '/api/generate', usd: 0.02 }],
  verifyBot: (ip, ua) => (/Googlebot/.test(ua) && ip.startsWith('66.249.') ? 'search_engine' : null),
};
