# Architecture

```
 customer backend / edge worker            server or CDN logs
        | thin SDK (hash ids, 150 ms deadline, fail open)   |
        v                                                   v
 +--------------- HTTP API (contracts/openapi.yaml) ----------------+
 |  /v1/events   /v1/decisions   /v1/signals   /v1/audits  webhooks |
 +---+---------------+---------------+--------------+---------------+
     v               v               v              v
  ingest ---> store adapter <--- signal slot    log analyzer
  (usage,     (memory | Postgres) (normalize,   (src/logAnalyzer.js)
   links)         |               stale/weak         |
                  v               dropped)           |
            scoring core  <-------+                  |
          (src/scoring.js: farm, scraper,            |
           legit, cost ratio)                        |
                  v                                  |
           decision engine (src/engine.js) <---------+  shadow verdicts
                  v
        verdict + explainer (src/explain.js) --> appeal, outcome labels, accuracy report
  credential adapters (Web Bot Auth, ag-pass) --> agent.credential signal --> agent lane (AGENT-LANE.md)
```

## ADR-1 Wedge: per-human cost budgets, audit first (changes the brief)

Decision: launch on dollar caps per linked subject cluster on expensive endpoints, entered through a free log audit. Scraper slow-down and the agent lane keep their contracts, vectors and engine paths but ship after the wedge.

Why: per-identifier budgets and signup detection already ship in tools buyers have (GAP-ANALYSIS.md); nobody found caps the person behind N identifiers.

Rejected: (a) general decision layer over vendor scores, an in-house rules job; (b) a new detector, which loses to network-scale vendors; (c) scraper-first, where the buyers who hurt most use free tools.

Trade-off: depends on linking quality we partly import from other vendors' signals, and on a gap that is Unknown, not Verified absent.

## ADR-2 Subject-centric core

Decision: score `{kind, id}` (account, API key, session, device cluster, payment instrument) joined by hashed link attributes. Rejected: account-centric model; it cannot express key farms, anonymous scrapers or clusters. Trade-off: callers must choose the subject and send link events.

## ADR-3 Deterministic additive rules, not a learned model

Decision: fixed weights and thresholds, pinned by golden vectors. Rejected: ML scoring; there are no labels, and verdicts must be explainable and portable across SDK languages. Trade-off: lower accuracy ceiling; weights need per-customer tuning.

## ADR-4 Shadow first, fail open, never a silent block

Decision: default mode is shadow; clients fail open; provider outages downgrade blocks; every non-allow carries a recovery path; inconclusive can only allow or step up. Rejected: fail-closed default. Trade-off: abuse passes during outages.

## ADR-5 Cross-customer signals: off

Decision: single-tenant by default; per-tenant salts make hashes unjoinable across tenants. Evaluated an opt-in shared signal (second global salt, k-anonymity of at least 5 tenants, counts only, no raw identifiers). Rejected for launch: legal review cost, re-identification risk on small k, and no customer base to give it value. Revisit after 20 tenants. Trade-off: no network effect against repeat farms.

## ADR-6 Language-agnostic core, thin SDKs

Decision: the API contract and golden vectors are the product; SDKs only hash, call, time out and fall back. Rejected: embedding the engine in each SDK; five rule copies drift. Trade-off: a network hop per inline decision.

## ADR-7 Bounded slow actions

Decision: slow means rate budget, 429 with Retry-After, or a cached/304 reply. No tarpits. Rejected: artificial delay; each held connection costs the defender memory and a socket. Proof-of-work is a step-up rung with non-JavaScript alternatives. Trade-off: determined scrapers pay only in request budget.

## Region and privacy notes

- Tenant rows are pinned to a region (`tenants.region`); EU and India data stay in-region.
- Card-on-file is a weak rung where cards are uncommon (India UPI, parts of EU); passkey and email rungs come first and the ladder is configurable.
- Retention default 90 days; erasure through `DELETE /v1/subjects`.
- Linking is profiling under GDPR: DECISIONS-FOR-HUMAN 6.
