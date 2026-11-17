# Gap analysis

Research: 12 web searches on 2026-11-17; only result excerpts were read, not full pages. Anything not in an excerpt is Unknown.

## Verdict

The product as briefed is not the strongest wedge:

- H1 (decision layer over other vendors' scores) is a rules engine a customer can write in-house.
- H4 as stated (per-subject dollar budgets) already ships: LiteLLM budgets per key and per end user [1]; Cloudflare AI Gateway spend limits per user id with 429 or cheaper-model fallback [2].
- Signup-abuse detection is bundled into Stripe Radar, which also shows "would have been blocked" [3][4].

The unserved part: gateway budgets follow the identifier the app passes, so one person with N free accounts gets N budgets. Detectors flag the accounts but do not meter dollars.

**Wedge (H9): per-human cost budgets.** Link accounts and keys into one subject cluster, cap the cluster's dollars on expensive endpoints, explain and offer recovery. Sold through a free log audit (H5).
**Follow-up: H3**, appeals and published per-customer accuracy.

## Findings

- Stripe: 7.4% of AI-company signups implicated; self-serve API startups see 10x more attempts; virtual-card blocking now rejects real users [4].
- Radar's model uses payment instrument, device and payment history [3]: weaker where signup has no card (ASSUMED common for API free tiers).
- Cloudflare spend limits are eventually consistent, 20 rules per gateway [2].
- HUMAN AgenticTrust permissions apply only to agents known to HUMAN [6].
- Anubis README calls itself "a bit of a nuclear response" that may block good bots [7]; it needs JavaScript [15].
- Founders ask publicly how to stop multi-account free-tier abuse [12]; denial-of-wallet bills are recurring incidents [13].

## Scores

Columns: severity, frequency, workaround cost, payer speed, willingness to pay, in-house difficulty, coverage gap, our edge, time to value.

|H|Sev|Frq|Wrk|Pay|WTP|InH|Gap|Edge|TTV|Sum|
|-|-|-|-|-|-|-|-|-|-|-|
|H1 merge layer|3|4|3|2|2|2|3|2|2|23|
|H2 agent lane|2|2|2|2|2|4|2|2|2|20|
|H3 appeals|3|3|3|2|2|3|4|3|2|25|
|H4 per-subject budgets|4|4|3|4|3|2|2|2|3|27|
|H5 log audit|3|4|2|3|2|2|3|3|5|27|
|H6 scraper slow|3|4|3|2|1|3|2|2|3|23|
|H7 accessible challenges|2|2|2|1|1|4|4|2|1|19|
|H8 evidence trails|2|1|2|1|2|3|4|2|1|18|
|**H9 per-human budgets**|4|4|4|4|3|3|4|3|4|**33**|

Scores are judgement, not measurement.

## Comparison matrix

V = verified in a vendor doc excerpt (ref), C = vendor claim only, U = unknown. U is not "absent".

|Tool|Multi-account detection|$ budget per identifier|$ budget per linked cluster|Shadow report|Named reasons|Appeal API|Per-agent policy|Log audit in $|
|-|-|-|-|-|-|-|-|-|
|Stripe Radar|V[3]|U|U|V[4]|U|U|U|U|
|Verisoul|V[5]|U|U|U|U|U|U|U|
|Castle|V[11]|U|U|U|U|U|U|U|
|Stytch DFP|C[9]|U|U|U|V[9]|U|U|U|
|Fingerprint|C[14]|U|U|U|U|U|U|U|
|Arcjet|U|U (request limits V[8])|U|U|U|U|U|U|
|LiteLLM|U|V[1]|U|U|U|U|U|U|
|Cloudflare AI Gateway|U|V[2]|U|U|U|U|U|U|
|HUMAN AgenticTrust|U|U|U|U|U|U|V[6]|U|
|Anubis|U|U|U|U|U|U|U|U|
|**abuseguard (this repo)**|behind|parity|better|parity|parity|better|behind|better|

Our row, per function:

- Behind on detection (no device fingerprinting, no network-wide model): we consume those vendors' signals.
- Behind on agent verification: adapters only.
- Parity on per-identifier budgets, shadow reporting and named reasons.
- "Better" on three columns rests on Unknown cells. Confirm by reading the Radar, Verisoul and Cloudflare docs in full before saying it to a customer (DECISIONS-FOR-HUMAN 2).

## Proof

Synthetic results are from `npm test` (`test/proof.test.js`, seed 42, 10,000 subjects). The populations are invented; they prove the mechanism only.

|Claim|Synthetic test and result|Shadow-pilot target|
|-|-|-|
|A1 Cluster budgets catch farm cost that per-identifier budgets miss|P3: 89.5% of farm cost caught vs 0% for a per-identifier budget; $349 per 1,000 subjects|At least 15% of free-tier cost sits in clusters over cap that the customer's current budget did not stop|
|A2 Shared networks are not punished|P2: 0 blocked or slowed, 2.45% asked for one step; an IP limiter flags 100%|Under 1% of paying users flagged; under 5% of appeals overturned|
|A3 Useful without third-party signals|P5: precision 96.3%, farm recall 80.7%, paying flagged 0%|Precision at least 90% on customer-labelled sample of 200|
|A4 Fast first value|P6: 38,652 log lines audited in about 0.2 s; decision 0.002 ms|Audit report under 1 hour from log handover; integration under 1 day|
|A5 Every non-allow has a recovery path; inconclusive never blocks|P4 and golden vectors: 100%|Median appeal resolution under 24 h|
|A6 Paying users are safe|P1: 0 of 1,085 flagged|Under 1% (frictionless target)|

Not claimed, because untestable here: better detection accuracy than any named vendor.

## Why a company would pay over what it has

1. Its gateway budget is per key; the farm has 200 keys. We cap the person.
2. Radar needs a payment touchpoint; we work from usage logs and API keys.
3. It gets a dollar figure from logs before integrating anything.

## What would change my mind

- Radar, Verisoul or Cloudflare documents cluster-level dollar caps.
- Three pilot audits show under 5% of free-tier cost in linked clusters.
- Buyers treat it as a two-week in-house SQL job (see ANALYSIS.md).

## Sources (all 2026-11-17)

1. https://docs.litellm.ai/docs/proxy/users
2. https://developers.cloudflare.com/ai-gateway/features/spend-limits/
3. https://stripe.com/blog/how-stripe-radar-helps-prevent-free-trial-abuse
4. https://stripe.com/blog/analyzing-first-party-fraud-trends-account-free-trial-and-refund-abuse
5. https://docs.verisoul.ai/signals-scores/multi-accounting
6. https://docs.humansecurity.com/applications/manage-ai-agent-permissions
7. https://github.com/TecharoHQ/anubis
8. https://docs.arcjet.com/rate-limiting/
9. https://stytch.com/docs/fraud-risk/device-fingerprinting/decisioning/overview
10. https://developers.cloudflare.com/ai-crawl-control/features/pay-per-crawl/what-is-pay-per-crawl/
11. https://docs.castle.io/docs/device-fingerprinting
12. https://www.reddit.com/r/SaaS/comments/1ir0e2z/ideas_for_preventing_free_tier_abuse/
13. https://ysecurity.io/blog/too-fancy-agent-50000-an-hour/
14. https://fingerprint.com/smart-signals-explorer/signals/suspect-score/
15. https://blog.ce9e.org/posts/2025-05-24-anubis/
