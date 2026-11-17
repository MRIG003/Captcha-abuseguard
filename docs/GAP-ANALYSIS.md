# Gap analysis

Research on 2026-11-17: 12 searches (excerpts), then T00: one doc page per vendor read in full for Stripe Radar, Verisoul, Castle, Cloudflare AI Gateway and LiteLLM. N = not mentioned on the page read; other pages may differ.

## Verdict

The product as briefed is not the strongest wedge:

- H1 (decision layer over vendor scores) is an in-house rules job.
- H4 as stated already ships: LiteLLM budgets per key, user, team and end user [1]; Cloudflare AI Gateway spend limits per any metadata value [2].
- Signup-abuse detection is bundled into Stripe Radar. Its account evaluations run at registration and login with no payment method and return named abuse reasons [16].

The unserved part: gateway budgets follow the identifier the app passes, so one person with N free accounts gets N budgets. Detectors link the accounts but do not meter dollars.

Caveat found in T00: a customer can combine the two itself by passing a detector's linked-account id as the gateway budget key (ASSUMED 1 to 3 days of glue, LLM spend only). No single tool does it; the combination nearly does.

**Wedge (H9): per-human cost budgets.** Link accounts and keys into one cluster, cap its dollars on expensive endpoints, explain, offer recovery. Entry: log audit (H5).
**Follow-up: H3**, appeals and published per-customer accuracy.

## Findings

- Stripe: 7.4% of AI-company signups implicated; self-serve API startups see 10x more attempts [4].
- Radar links on device, email and IP reuse and needs no card [16]. The earlier "Radar needs a payment touchpoint" argument is withdrawn.
- Verisoul returns linked accounts with match types (browser, network, device, phone, username) [5].
- Cloudflare's identity-driven budgets cover employees through Cloudflare Access, not outside users [17].
- HUMAN AgenticTrust permissions apply only to agents known to HUMAN [6].
- Founders ask publicly how to stop multi-account free-tier abuse [12]; denial-of-wallet bills recur [13].

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

Scores are judgement.

## Comparison matrix

V = verified in vendor docs (ref), C = vendor claim only, N = not mentioned on the page read, U = unknown. Neither N nor U means absent.

|Tool|Multi-account detection|$ budget per identifier|$ budget per linked cluster|Shadow report|Named reasons|Appeal API|Per-agent policy|Log audit in $|
|-|-|-|-|-|-|-|-|-|
|Stripe Radar|V[16]|N|N|V[4]|V[16]|N|U|N|
|Verisoul|V[5]|N|N|N|V[5]|N|U|N|
|Castle|V[11]|N|N|N|V[11]|N|U|N|
|Stytch DFP|C[9]|U|U|U|V[9]|U|U|U|
|Fingerprint|C[14]|U|U|U|U|U|U|U|
|Arcjet|U|U (request limits V[8])|U|U|U|U|U|U|
|LiteLLM|N|V[1]|N|N|U|N|U|U|
|Cloudflare AI Gateway|N|V[2]|N|N|U|N|U|U|
|HUMAN AgenticTrust|U|U|U|U|U|U|V[6]|U|
|Anubis|U|U|U|U|U|U|U|U|
|**abuseguard (this repo)**|behind|parity|better as one product|parity|parity|better|behind|better|

Our row, per function:

- Behind on detection and agent verification: we consume those vendors' signals.
- Parity on per-identifier budgets, shadow reporting and named reasons.
- Cluster budgets: better only as one integrated product, and for cost outside LLM calls. Two tools a customer may already own can be glued to do the LLM part.
- Appeals and log audit: "better" rests on N cells from one page per vendor, not on confirmed absence.

## Proof

Synthetic results: `test/proof.test.js`, seed 42, 10,000 invented subjects. They prove the mechanism only.

|Claim|Synthetic test and result|Shadow-pilot target|
|-|-|-|
|A1 Cluster budgets catch farm cost that per-identifier budgets miss|P3: 89.5% of farm cost caught vs 0% for a per-identifier budget; $349 per 1,000 subjects|At least 15% of free-tier cost in clusters the current budget missed|
|A2 Shared networks are not punished|P2: 0 blocked or slowed, 2.45% asked for one step; an IP limiter flags 100%|Under 1% of paying users flagged; under 5% of appeals overturned|
|A3 Useful without third-party signals|P5: precision 96.3%, farm recall 80.7%, paying flagged 0%|Precision at least 90% on 200 labelled subjects|
|A4 Fast first value|P6: 38,652 log lines audited in about 0.2 s; decision 0.002 ms|Audit under 1 hour; integration under 1 day|
|A5 Recovery path on every non-allow; inconclusive never blocks|P4 and golden vectors: 100%|Median appeal resolution under 24 h|
|A6 Paying users are safe|P1: 0 of 1,085 flagged|Under 1% (frictionless target)|

Not claimed: better detection accuracy than any named vendor.

## Why a company would pay over what it has

1. Its gateway budget is per key; the farm has 200 keys. We cap the person, with no glue to build or maintain.
2. Cost on any endpoint (compute, bandwidth, database), not only model calls a gateway can price.
3. A dollar figure from logs before integrating anything, and a recovery path for wrongly limited users.

## What would change my mind

- Radar, Verisoul or Cloudflare documents cluster-level dollar caps, or buyers say the glue is easy enough.
- Three pilot audits show under 5% of free-tier cost in linked clusters.

## Sources

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
16. https://docs.stripe.com/radar/customer-account-evaluations
17. https://blog.cloudflare.com/ai-gateway-spend-limits
