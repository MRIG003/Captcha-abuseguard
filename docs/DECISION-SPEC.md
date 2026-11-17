# Decision spec 1.0.0

Normative together with `contracts/golden-vectors.json` (60 vectors). Where prose and vectors disagree, vectors win. Reference: `src/scoring.js`, `src/engine.js`. Request and response shapes: `contracts/openapi.yaml`.

## 1. Signals

Each signal has type, value, confidence, freshness, provenance. Per type, the most confident usable signal wins.

- Dropped as stale if older than 86,400 s (`agent.credential`: 300 s). Reason `STALE_SIGNAL_IGNORED`.
- Dropped if confidence is under 0.3. Reason `LOW_CONFIDENCE_SIGNAL_IGNORED`.
- No signals at all: reason `NO_EXTERNAL_SIGNALS`; the engine still decides.
- Any provider not `ok`: reason `PROVIDER_DEGRADED`, confidence capped at 0.7, farm `block` becomes `step_up`.

## 2. Scores

All scores are sums of weights, clamped to 0..1 and rounded to four decimals.

**legit**

|Evidence|Weight|Reason|
|-|-|-|
|paying|0.5|PAYING_CUSTOMER|
|tenure of 90 days or more|0.2|ESTABLISHED_TENURE|
|email confirmed 0.1, passkey 0.2, own card 0.2|sum|VERIFIED_CONTACT|
|human check passed|0.3 x confidence|HUMAN_CHECK_PASSED|

A card shared by three or more subjects does not count as an own card.

**farm** = evidence - 0.5 x legit

|Evidence|Weight|Reason|
|-|-|-|
|device cluster of 3 or more (10 or more)|0.4 (0.6)|DEVICE_CLUSTER|
|payment cluster of 3 or more (5 or more)|0.3 (0.5)|PAYMENT_CLUSTER|
|provider multi-account risk of 0.5 or more|0.5 x value x confidence|PROVIDER_MULTI_ACCOUNT_RISK|
|10 or more signups per hour among linked subjects|0.2|SIGNUP_VELOCITY|
|disposable email|0.15|DISPOSABLE_EMAIL|
|IP cluster of 20 or more, no shared-network signal|0.15|IP_CLUSTER_WEAK|
|IP cluster of 20 or more with shared-network signal|0|SHARED_NETWORK_DISCOUNT|

A **strong link** is a device or payment cluster of 3 or more, or provider risk with value and confidence both at least 0.8. Without a strong link, farm is capped at 0.7 and the class cannot be `likely_farm`.

**scraper** (only when `context.surface` is `content`) = evidence - 0.5 x legit

|Evidence|Weight|Reason|
|-|-|-|
|120 or more requests per minute (600 or more)|0.3 (0.5)|HIGH_REQUEST_RATE|
|robots.txt violations|0.3|ROBOTS_VIOLATION|
|half or more requests re-fetch unchanged content|0.2|UNCHANGED_REFETCH|
|proxy network: residential 0.2, other 0.15|x confidence|PROXY_NETWORK|
|HTTP library or empty user agent|0.1|NON_BROWSER_CLIENT|

**cost ratio** = attributed dollars / budget (request budget, else `AG_BUDGET_USD`). Reasons `COST_NEAR_BUDGET` at 0.8, `COST_OVER_BUDGET` at 1. The caller supplies cluster-aggregated cost when links exist.

## 3. Classification, first match wins

1. Verified search engine (`bot.verified`, confidence 0.8 or more): `search_engine`, allow. Never slowed.
2. Other verified crawler: `declared_crawler`; allow, or slow by rate budget above 60 requests per minute.
3. Self-declared bot on content, no robots violations, within crawl rate: `declared_crawler`, allow.
4. Assistive tool declared (confidence 0.5 or more), unless strong link with farm at 0.5 or more, or scraper at 0.8 or more: `assistive_tool`; allow, or limit when a non-paying subject is over budget. Never step-up, slow or block.
5. Verified agent credential (confidence 0.8 or more): `delegated_agent`. In order: policy deny gives block with `human_path`; scope outside policy gives step-up `human_handoff`; not user-bound off the content surface gives step-up `agent_pass_bind`; person over cap gives limit; over agent rate gives slow; else allow.
6. Farm at 0.5 or more: with strong link `likely_farm`, block at 0.85 or more, else step-up; without strong link `inconclusive`, step-up.
7. API key used from 25 or more client networks: `reseller`; paying allow, else limit.
8. Scraper at 0.6 or more: `suspected_scraper`, slow. From 0.35: `inconclusive`, step-up `proof_of_work`.
9. Unverified agent: `inconclusive`; allow on content, else step-up `agent_registration`.
10. Over budget: `legitimate_heavy_user`; paying allow, else limit.
11. Otherwise `legitimate_user`, or `legitimate_heavy_user` when paying with 120 or more requests per minute or cost ratio at 0.8 or more. Allow.

Two classes were added to the brief's list because it had no class for an ordinary user or a polite crawler: `legitimate_user`, `declared_crawler`.

## 4. Actions

|Decision|Action|
|-|-|
|step_up|First unsatisfied rung of email_confirm, passkey, card_on_file, human_check, manual_review. `likely_farm` starts at card_on_file. Remaining rungs are `alternatives`; `manual_review` is always present, so a non-visual, non-gesture, non-camera path always exists.|
|slow|`cached` (304 or cached reply) when half or more requests are unchanged re-fetches; `retry_after` (429, 60 s) at scraper 0.8 or more; else `rate_budget` (30 requests per minute). No artificial delay.|
|limit|429 with Retry-After until the budget window resets.|
|block|403. Only `likely_farm` at 0.85 or more with a strong link and healthy providers, or an agent denied by policy.|

## 5. Recovery

Every non-allow verdict carries `recovery` with `appeal: true`, paths and an SLA (default 24 h). `inconclusive` can only allow or step up.

## 6. Modes and fallback

- `shadow` (default): the real decision is returned and stored, `enforced: false`, `effective_decision: allow`.
- Client fallback when the engine is unreachable: allow with `ENGINE_UNAVAILABLE`; in fail-closed mode a step-up with `manual_review`. Never a block.

## 7. Confidence

The winning score (farm or scraper), the verifying signal's confidence, a fixed 0.6 to 0.7 for budget and reseller rules, 0.4 for unverified agents, or `1 - max(farm, scraper)` bounded to 0.5..0.99 for legitimate classes. It ranks verdicts; it is not a calibrated probability.

## 8. Configuration

Every threshold above is an `AG_*` environment variable with the default shown in `loadConfig` (`src/scoring.js`). Golden vectors assume defaults.

## 9. Versioning

Reason codes are append-only. A changed vector outcome is a major version.

## 10. Known limits

- Linking quality bounds everything. A farm with distinct devices, no shared card and no provider signal scores as individual users; only the budget limit applies.
- Assistive declaration is self-asserted.
- Weights are judgement, tuned on synthetic data only.
