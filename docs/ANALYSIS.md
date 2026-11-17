# Analysis

## 1. Substitutes: change the free tier instead

|Substitute|Cost to the company|When it beats us|
|-|-|-|
|Require a card at signup plus Stripe Radar|Conversion loss (size ASSUMED); Stripe says blocking virtual cards now rejects real users|Card-first products; no API-only signup|
|Shrink or remove the free tier|Slower acquisition|Product sells top-down|
|Per-key gateway budget (LiteLLM, Cloudflare)|None; already owned|Abuse is single heavy keys, not many keys|
|In-house job: group usage by device hash, cap the group|2 to 4 engineer-weeks (ASSUMED) plus upkeep|Team already stores device identifiers|
|Phone or ID verification|Friction, regional bias, privacy exposure|High-value accounts only|

Plain reading: for a card-first company, Radar plus a gateway budget is enough and we should not sell to it. Our buyer is the API-first company with cardless signup and a cost per request high enough to matter.

## 2. Segment fit

- Best: Series A-C AI/API companies, self-serve free tier, inference cost per request.
- Fair: developer platforms with free compute (CI minutes, sandboxes, hosted databases).
- Poor for launch: publishers and self-hosters hit by scrapers. Pain is real, budgets are small, free tools exist. Engine paths are kept for later.
- Phase 2, anonymous traffic (guest checkout, ticket queues, public APIs, form spam): no durable subject exists, so linking leans on device and network attributes with weaker lawful basis. Hooks only: `session` and `device_cluster` subject kinds, the log audit.

## 3. Human-verification products

They answer "is a person present now"; we answer "how much has this person already consumed". A live check (including Proof of Presence) is one optional ladder rung through the signal slot (`human.liveness`). It needs a browser, so it cannot be the only rung for API signups, and its published results are simulations. We never depend on one.

## 4. Timing and bundling risk

|Risk|Leading indicator|
|-|-|
|Stripe Radar adds usage or cost signals across linked accounts|Radar changelog mentions compute cost or account graphs|
|Cloudflare AI Gateway "identity-driven budgets" (closed beta per its blog) add account linking|Beta notes mention device or multi-account identity|
|Verisoul or Castle add dollar metering|Pricing pages mention cost or budget|
|LiteLLM adds cluster keys|Issue tracker requests for budgets across keys|

Any one of these makes the wedge a feature. Check quarterly.

## 5. Adversary adaptation (design level)

- Spreading over more devices and cards raises the attacker's cost per account, which is the goal; the budget limit still bounds each one.
- Farms that cannot be linked are not detected. Claimed recall must exclude them.
- Self-declaring as assistive or as an agent is bounded by the exemption limits and by per-human caps.
- Forcing provider timeouts yields a step-up, not a pass.
- Poisoning appeals: overturn decisions are logged and counted; a spike in appeals from one cluster is itself a signal for review.

## 6. Validation of unverified numbers

|Number|Status|Cheapest check|
|-|-|-|
|7.4% of AI signups in multi-account abuse; 6.2x trial abuse; 550,000 trials, $4.4M|Vendor-reported (Stripe)|Compare with three pilot audits|
|About 1 in 6|Secondary source|Same|
|$2-3 infrastructure cost per fake trial|One anecdote|Ask five founders for cost per free signup|
|22B scrapes; over 50% re-fetch unchanged|Vendor-reported|Measure re-fetch share in pilot logs|
|19% abandon over CAPTCHAs|Vendor-cited survey|Not needed; we add no CAPTCHA|
|API signups are mostly cardless|ASSUMED|Check signup flows of 30 target companies|
|In-house fix takes 2-4 weeks|ASSUMED|Ask three platform engineers|
|3,000-6,000 companies at $20K-$80K|ASSUMED|Count companies with a public free API tier in one directory|
|Synthetic proof results|Invented populations|Shadow pilot with labelled sample|
|$0.02 per subject, $1,500/month, 15% of savings|Untested prices|Offer two prices to alternating prospects|

## 7. Market size

Serviceable market = companies x annual contract value.

|Input|Low|Base|High|
|-|-|-|-|
|Companies|3,000|4,500|6,000|
|Contract value|$20K|$40K|$80K|
|Market|$60M|$180M|$480M|

Obtainable revenue = companies x share with cardless signup x share reachable x win rate x price. At the tested $1,500/month the price is $18K, below the low contract value. With ASSUMED 50% cardless, 20% reachable, 10% win rate: 4,500 x 0.5 x 0.2 x 0.1 x $18K = $0.8M a year.

Most sensitive input: contract value (4x range against 2x for company count). Second: the cardless share, which gates everything.

## 8. Kill criteria

- T00 finds a mainstream tool with cluster-level dollar caps.
- Three pilot audits each show under 5% of free-tier cost in linked clusters.
- Under 3 of 15 qualified buyers accept a free audit.
- Shadow pilots flag over 1% of paying users after tuning.
- Counsel finds no workable lawful basis for device linking in the EU.

## 9. Top risks and one experiment each

|Risk|Experiment|
|-|-|
|The gap is not real|T00: read competitor docs fully; one day|
|Bundling by Stripe or Cloudflare|Ask ten buyers whether they would still buy if Radar showed this number|
|Linking too weak without a fingerprint vendor|Run the audit on one pilot's logs plus its device ids; measure farm cost found with and without|
|In-house substitute|Offer the audit free; count how many build it themselves within 30 days|
|False positives on real users|Two-week shadow pilot; hand-label 200 flagged subjects|

## 10. Not verified in this run

- Full vendor pages; only search excerpts were read, so every Unknown cell may hide a feature.
- Pricing of any competitor.
- The Postgres adapter against a database; CI on macOS, Windows and Node 24.
- Any real traffic. All accuracy figures are synthetic.
- Legal positions (GDPR, CCPA, DPDP, accessibility law).
- The dated facts in the brief (court ruling, draft revision, Cloudflare default-block date) were taken as given.
