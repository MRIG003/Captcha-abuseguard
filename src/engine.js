// @ts-check
/** Decision engine: evidence scores -> class, decision, bounded action, recovery path. Pure and deterministic. */
import { DEFAULT_CONFIG, SPEC_VERSION, score } from './scoring.js';

const LADDER = ['email_confirm', 'passkey', 'card_on_file', 'human_check', 'manual_review'];
const STRONG = ['card_on_file', 'human_check', 'manual_review'];
const PATHS = {
  slow: ['identify_client', 'request_api_access'],
  limit: ['wait_for_reset', 'add_payment_method', 'upgrade_plan'],
  block: ['manual_review'],
};

/** Next unsatisfied rung. `manual_review` is always last, so a non-visual, non-gesture path always exists. */
function stepUp(b, sig, strong, order) {
  const done = {
    email_confirm: !!b.email_confirmed, passkey: !!b.passkey,
    card_on_file: !!b.card_on_file && (b.payment_cluster ?? 0) < 3,
    human_check: sig['human.liveness']?.value === 'pass',
  };
  // A tenant may reorder or drop rungs; manual_review is always kept last so a way through always exists.
  const ladder = Array.isArray(order) && order.length ? [...order.filter((r) => r !== 'manual_review'), 'manual_review'] : LADDER;
  const from = strong ? ladder.filter((r) => STRONG.includes(r) || !LADDER.includes(r)) : ladder;
  const open = from.filter((rung) => !done[rung]);
  return { type: 'step_up', step: open[0], alternatives: open.slice(1) };
}
const special = (step) => ({ type: 'step_up', step, alternatives: ['manual_review'] });

/**
 * Assess one subject.
 * @param {any} input assessment request (contracts/openapi.yaml#AssessRequest)
 * @param {any} [config] partial config merged over defaults
 */
export function decide(input, config = DEFAULT_CONFIG) {
  const cfg = config === DEFAULT_CONFIG ? config : { ...DEFAULT_CONFIG, ...config };
  const s = score(input, cfg), sig = s.sig, b = input.behavior ?? {};
  const surface = input.context?.surface ?? 'api', rpm = b.rpm ?? 0, paying = b.paying === true;
  const reasons = [...s.reasons];
  const degraded = Object.values(input.providers ?? {}).some((status) => status !== 'ok');
  if (degraded) reasons.push('PROVIDER_DEGRADED');
  if (!(input.signals ?? []).length) reasons.push('NO_EXTERNAL_SIGNALS');

  const over = s.costRatio >= 1, order = input.policy?.step_up_order;
  const bot = sig['bot.verified'], assist = sig['assistive.tool'], cred = sig['agent.credential'];
  const botOk = !!bot && bot.confidence >= 0.8;
  const credOk = !!cred && cred.value?.verified === true && cred.confidence >= 0.8;
  const unverifiedAgent = (!!cred && !credOk) || (!cred && b.ua === 'declared_agent');
  const slow = (mode) => (mode === 'cached' ? { type: 'slow', mode, status: 304 }
    : mode === 'retry_after' ? { type: 'slow', mode, status: 429, retry_after_s: cfg.retryAfterS }
      : { type: 'slow', mode: 'rate_budget', status: 429, rpm: cfg.slowRpm, retry_after_s: Math.ceil(60 / cfg.slowRpm) });
  const limit = { type: 'limit', status: 429, retry_after_s: cfg.windowS, reset: 'window' };
  const v = (cls, decision, confidence, why = [], action = null, paths = []) => ({ cls, decision, confidence, why, action, paths });
  let r;

  if (botOk && bot.value === 'search_engine') {
    r = v('search_engine', 'allow', bot.confidence, ['VERIFIED_SEARCH_ENGINE']);
  } else if (botOk) {
    r = rpm > cfg.crawlerRpm
      ? v('declared_crawler', 'slow', bot.confidence, ['VERIFIED_CRAWLER', 'CRAWL_BUDGET_EXCEEDED'], slow('rate_budget'))
      : v('declared_crawler', 'allow', bot.confidence, ['VERIFIED_CRAWLER']);
  } else if (surface === 'content' && b.ua === 'declared_bot' && !(b.robots_violations > 0) && rpm <= cfg.crawlerRpm) {
    r = v('declared_crawler', 'allow', 0.5, ['DECLARED_BOT_POLITE']);
  } else if (assist && assist.confidence >= 0.5 && !(s.strongLink && s.farm >= cfg.farmStepUp) && s.scraper < 0.8) {
    // Same per-human cap as everyone else, never a challenge, slow-down or block.
    r = over && !paying ? v('assistive_tool', 'limit', assist.confidence, ['ASSISTIVE_DECLARED'], limit)
      : v('assistive_tool', 'allow', assist.confidence, ['ASSISTIVE_DECLARED']);
  } else if (credOk) {
    const pol = { mode: 'allow', rpm: cfg.agentRpm, ...(input.agent_policy ?? {}) };
    const scope = input.context?.scope, c = cred.confidence, ok = ['VERIFIED_AGENT_CREDENTIAL'];
    if (pol.mode === 'deny') r = v('delegated_agent', 'block', c, [...ok, 'AGENT_POLICY_DENY'], null, ['human_path', 'request_agent_access']);
    else if (pol.scopes && scope && !pol.scopes.includes(scope)) r = v('delegated_agent', 'step_up', c, [...ok, 'AGENT_SCOPE_DENIED'], special('human_handoff'));
    else if (!cred.value.user_bound && surface !== 'content') r = v('delegated_agent', 'step_up', c, [...ok, 'AGENT_NOT_USER_BOUND'], special('agent_pass_bind'));
    else if (over) r = v('delegated_agent', 'limit', c, [...ok, 'AGENT_HUMAN_CAP_EXCEEDED'], limit);
    else if (rpm > pol.rpm) r = v('delegated_agent', 'slow', c, [...ok, 'AGENT_RATE_LIMIT'], slow('retry_after'));
    else r = v('delegated_agent', 'allow', c, ok);
  }

  if (!r) {
    const flags = [...(unverifiedAgent ? ['AGENT_UNVERIFIED'] : []), ...(assist ? ['ASSISTIVE_DECLARED'] : [])];
    if (s.farm >= cfg.farmStepUp) {
      r = !s.strongLink ? v('inconclusive', 'step_up', s.farm, flags, stepUp(b, sig, false, order))
        : s.farm >= cfg.farmBlock && !degraded ? v('likely_farm', 'block', s.farm, flags)
          : v('likely_farm', 'step_up', s.farm, flags, stepUp(b, sig, true, order));
    } else if (input.subject?.kind === 'api_key' && (b.key_fanout ?? 0) >= cfg.fanoutReseller) {
      r = v('reseller', paying ? 'allow' : 'limit', 0.6, [...flags, 'KEY_FANOUT'], paying ? null : limit);
    } else if (s.scraper >= cfg.scraperSlow) {
      const mode = (b.refetch_unchanged ?? 0) >= 0.5 ? 'cached' : s.scraper >= 0.8 ? 'retry_after' : 'rate_budget';
      r = v('suspected_scraper', 'slow', s.scraper, flags, slow(mode));
    } else if (s.scraper >= cfg.scraperWatch) {
      r = v('inconclusive', 'step_up', s.scraper, flags,
        { type: 'step_up', step: 'proof_of_work', alternatives: ['email_confirm', 'request_api_access', 'manual_review'] });
    } else if (unverifiedAgent) {
      r = surface === 'content' ? v('inconclusive', 'allow', 0.4, flags)
        : v('inconclusive', 'step_up', 0.4, flags, special('agent_registration'), ['human_path']);
    } else if (over) {
      r = v('legitimate_heavy_user', paying ? 'allow' : 'limit', 0.7, flags, paying ? null : limit);
    } else {
      const heavy = paying && (rpm >= cfg.rpmHigh || s.costRatio >= 0.8);
      const confidence = Math.max(0.5, Math.min(0.99, 1 - Math.max(s.farm, s.scraper)));
      r = v(heavy ? 'legitimate_heavy_user' : 'legitimate_user', 'allow', confidence, flags);
    }
  }

  // Standing and tenant settings adjust the action after classification; the class and scores stay as computed.
  let decision = r.decision, act = r.action;
  const st = input.standing ?? {}, allowed = input.policy?.allowed_actions, adjust = [];
  const pow = { type: 'step_up', step: 'proof_of_work', alternatives: ['email_confirm', 'manual_review'] };
  if (st.trusted && ['block', 'step_up', 'slow'].includes(decision) && r.cls !== 'delegated_agent') { decision = 'allow'; act = null; adjust.push('OPERATOR_TRUSTED'); }
  if (st.appeal_open && decision === 'block') { decision = 'step_up'; act = stepUp(b, sig, true, order); adjust.push('APPEAL_OPEN'); }
  if (Array.isArray(allowed) && decision !== 'allow' && !allowed.includes(decision)) {
    adjust.push('ACTION_NOT_PERMITTED');
    const viaStepUp = (decision === 'block' || decision === 'slow') && allowed.includes('step_up');
    act = viaStepUp ? (decision === 'block' ? stepUp(b, sig, true, order) : pow) : null;
    decision = viaStepUp ? 'step_up' : 'allow';
  }
  const action = act ?? (decision === 'block' ? { type: 'block', status: 403 } : null);
  const enforced = (input.mode ?? cfg.mode) === 'enforce';
  const stepPaths = action?.type === 'step_up' ? [action.step, ...action.alternatives] : [];
  return {
    spec_version: SPEC_VERSION,
    subject: input.subject ?? null,
    class: r.cls,
    decision,
    enforced,
    effective_decision: enforced ? decision : 'allow',
    confidence: Math.round((degraded ? Math.min(r.confidence, 0.7) : r.confidence) * 100) / 100,
    reasons: [...new Set([...r.why, ...adjust, ...reasons])],
    scores: { farm: s.farm, scraper: s.scraper, legit: s.legit, cost_ratio: s.costRatio },
    action,
    recovery: decision === 'allow' ? null : {
      appeal: true,
      paths: [...new Set([...(decision === r.decision ? r.paths : []), ...stepPaths, ...(PATHS[decision] ?? []), 'appeal'])],
      sla_hours: cfg.appealSlaHours,
    },
    cost: { attributed_usd: s.costUsd, budget_usd: s.budgetUsd },
  };
}

/** What a client returns when the engine is unreachable or too slow. Never a block. */
export function fallbackDecision(subject, config = DEFAULT_CONFIG) {
  const cfg = { ...DEFAULT_CONFIG, ...config }, closed = cfg.failMode === 'closed';
  const action = closed ? { type: 'step_up', step: 'email_confirm', alternatives: ['passkey', 'manual_review'] } : null;
  return {
    spec_version: SPEC_VERSION, subject: subject ?? null, class: 'inconclusive',
    decision: closed ? 'step_up' : 'allow', enforced: closed, effective_decision: closed ? 'step_up' : 'allow',
    confidence: 0, reasons: ['ENGINE_UNAVAILABLE'], scores: { farm: 0, scraper: 0, legit: 0, cost_ratio: 0 }, action,
    recovery: closed ? { appeal: true, paths: ['email_confirm', 'passkey', 'manual_review', 'appeal'], sla_hours: cfg.appealSlaHours } : null,
    cost: { attributed_usd: 0, budget_usd: cfg.budgetUsd },
  };
}
