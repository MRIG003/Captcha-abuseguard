// @ts-check
/**
 * Ready-made setups by business type. A preset is only a starting policy: every field can be overridden with
 * PUT /v1/policy. Rule: customers are fitted with settings and presets, never with code written for one customer.
 * All presets start in watch-only mode. Numbers are starting points, not recommendations backed by data.
 */
const step = (...order) => ({ step_up_order: order });

export const PRESETS = Object.freeze({
  ai_app: {
    label: 'AI app with a free plan', protects: ['signup', 'api'], unit: 'usd', strictness: 'watch',
    budget_usd: 5, window_s: 86400, budgets: [{ match: { plan: 'pro' }, budget_usd: 200 }],
    allowed_actions: ['step_up', 'slow', 'limit', 'block'], ...step('email_confirm', 'passkey', 'card_on_file', 'human_check', 'manual_review'),
    agents: { default: { mode: 'allow', rpm: 60 } },
  },
  online_store: {
    label: 'Online store', protects: ['signup', 'content'], unit: 'items', strictness: 'watch',
    budget_usd: 2, window_s: 86400, allowed_actions: ['step_up', 'slow', 'limit'],
    ...step('email_confirm', 'passkey', 'human_check', 'manual_review'), agents: { default: { mode: 'allow', rpm: 30, scopes: ['read'] } },
  },
  ticketing: {
    label: 'Ticketing and limited drops', protects: ['signup', 'api'], unit: 'tickets', strictness: 'watch',
    budget_usd: 4, window_s: 604800, allowed_actions: ['step_up', 'limit', 'block'],
    ...step('human_check', 'passkey', 'manual_review'), agents: { default: { mode: 'deny' } },
  },
  publisher: {
    label: 'Publisher or listings site', protects: ['content'], unit: 'pages', strictness: 'watch',
    budget_usd: 600, window_s: 3600, allowed_actions: ['slow', 'limit'], thresholds: { crawlerRpm: 30 },
    ...step('proof_of_work', 'email_confirm', 'manual_review'), agents: { default: { mode: 'allow', rpm: 30, scopes: ['read'] } },
  },
  rewards_app: {
    label: 'Fintech or rewards app', protects: ['signup'], unit: 'bonuses', strictness: 'watch',
    budget_usd: 1, window_s: 2592000, allowed_actions: ['step_up', 'limit', 'block'],
    ...step('passkey', 'card_on_file', 'human_check', 'manual_review'), agents: { default: { mode: 'deny' } },
  },
});

/** Strictness maps to mode and thresholds. `gentle` enforces but can never block. */
export function strictnessConfig(strictness) {
  if (strictness === 'gentle') return { mode: 'enforce', farmBlock: 2 };
  if (strictness === 'strict') return { mode: 'enforce' };
  if (strictness === 'watch') return { mode: 'shadow' };
  return {};
}
