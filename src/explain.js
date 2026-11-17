// @ts-check
/** Verdict explainer. REASON_TEXT is the registry of stable reason codes: add codes, never rename or reuse them. */

export const REASON_TEXT = Object.freeze({
  VERIFIED_SEARCH_ENGINE: 'Verified search engine crawler.',
  VERIFIED_CRAWLER: 'Crawler identity was verified by a signal provider.',
  DECLARED_BOT_POLITE: 'Self-declared bot that obeys robots.txt and stays within the crawl budget.',
  CRAWL_BUDGET_EXCEEDED: 'Verified crawler is above the crawl-rate budget.',
  ASSISTIVE_DECLARED: 'Assistive technology is declared; challenges and slow-downs are not applied.',
  VERIFIED_AGENT_CREDENTIAL: 'Agent presented a verified credential.',
  AGENT_UNVERIFIED: 'Client says it is an agent but has no verified credential.',
  AGENT_POLICY_DENY: 'Site policy does not admit this agent.',
  AGENT_SCOPE_DENIED: 'Agent asked for an action outside its allowed scope.',
  AGENT_NOT_USER_BOUND: 'Agent credential is not bound to a user of this site.',
  AGENT_HUMAN_CAP_EXCEEDED: 'The person this agent acts for has used their full allowance.',
  AGENT_RATE_LIMIT: 'Agent is above its request-rate limit.',
  DEVICE_CLUSTER: 'Several subjects share one device.',
  PAYMENT_CLUSTER: 'Several subjects share one payment instrument.',
  PROVIDER_MULTI_ACCOUNT_RISK: 'A signal provider reports multi-account risk.',
  SIGNUP_VELOCITY: 'Unusually fast signups from linked subjects.',
  DISPOSABLE_EMAIL: 'Disposable email domain.',
  IP_CLUSTER_WEAK: 'Many subjects share an IP address (weak evidence on its own).',
  SHARED_NETWORK_DISCOUNT: 'Shared network (campus, office or mobile carrier); the shared IP is not counted.',
  KEY_FANOUT: 'One API key is used from many unrelated clients.',
  HIGH_REQUEST_RATE: 'Request rate is far above normal reading speed.',
  ROBOTS_VIOLATION: 'Requests to paths disallowed by robots.txt.',
  UNCHANGED_REFETCH: 'Most requests re-fetch content that has not changed.',
  PROXY_NETWORK: 'Traffic arrives through a proxy network.',
  NON_BROWSER_CLIENT: 'Client is an HTTP library, not a browser.',
  COST_OVER_BUDGET: 'Attributed cost is above the budget for this window.',
  COST_NEAR_BUDGET: 'Attributed cost is above 80% of the budget.',
  PAYING_CUSTOMER: 'Paying customer.',
  ESTABLISHED_TENURE: 'Account is at least 90 days old.',
  VERIFIED_CONTACT: 'Confirmed email, passkey or own payment method.',
  HUMAN_CHECK_PASSED: 'Passed a human check from a signal provider.',
  PROVIDER_DEGRADED: 'A signal provider was slow or down; confidence is capped and blocks are downgraded.',
  NO_EXTERNAL_SIGNALS: 'Decided from own observations only.',
  STALE_SIGNAL_IGNORED: 'A signal was too old and was ignored.',
  LOW_CONFIDENCE_SIGNAL_IGNORED: 'A signal was too uncertain and was ignored.',
  ENGINE_UNAVAILABLE: 'The decision service did not answer in time; fallback applied.',
});

const PATH_TEXT = Object.freeze({
  email_confirm: 'Confirm your email address.', passkey: 'Register a passkey.',
  card_on_file: 'Add a payment method (not charged).', human_check: 'Complete a short human check.',
  proof_of_work: 'Let your client complete a short computation.', manual_review: 'Ask for a manual review.',
  appeal: 'Appeal this decision.', wait_for_reset: 'Wait for the allowance to reset.',
  add_payment_method: 'Add a payment method to raise the allowance.', upgrade_plan: 'Upgrade the plan.',
  identify_client: 'Identify your client (signed requests or a contact URL).',
  request_api_access: 'Request API access.', human_path: 'Continue without the agent.',
  request_agent_access: 'Ask the site to admit this agent.', agent_registration: 'Register the agent and obtain a pass.',
  agent_pass_bind: 'Bind the agent pass to your account.', human_handoff: 'Hand this step back to the person.',
});

const HEADLINE = Object.freeze({
  allow: 'Request allowed.', step_up: 'One more step is needed.', slow: 'Requests are being slowed.',
  limit: 'The allowance for this period is used up.', block: 'Access is paused pending review.',
});

/** Plain-language explanation for operators and end users. @param {any} verdict */
export function explain(verdict) {
  return {
    headline: HEADLINE[verdict.decision] ?? verdict.decision,
    class: verdict.class,
    confidence: verdict.confidence,
    enforced: verdict.enforced,
    reasons: verdict.reasons.map((code) => ({ code, text: REASON_TEXT[code] ?? code })),
    next_steps: (verdict.recovery?.paths ?? []).map((path) => ({ path, text: PATH_TEXT[path] ?? path })),
    appeal_sla_hours: verdict.recovery?.sla_hours ?? null,
  };
}
