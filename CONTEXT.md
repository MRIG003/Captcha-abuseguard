# CONTEXT

Start here. This file is enough to continue the build without the original conversation.

## What this is

abuseguard is a traffic referee for companies whose free tiers and expensive endpoints are drained by people
running many accounts or keys. It is defensive only: it protects a company's own resources.

**Launch wedge: per-human cost budgets.** Link accounts, API keys, sessions and payment instruments into one
subject cluster; cap the cluster's dollars on expensive endpoints; explain every verdict; always offer a way back.
The entry point is a free bot load and cost audit from server or CDN logs, in shadow mode.

Why this and not the original brief (a general decision layer): per-identifier dollar budgets already ship in
LiteLLM and Cloudflare AI Gateway, and signup-abuse detection is bundled in Stripe Radar (no card needed). What was
not found in any single tool is a budget that follows the person across identifiers; a customer can approximate it
by gluing a detector to a gateway. Evidence, scores and the honest limits of that claim:
`docs/GAP-ANALYSIS.md`. Follow-up wedge: appeals and published per-customer accuracy.

Buyer: head of growth or platform at a Series A-C AI/API company with a self-serve free tier.
Team assumption: 2 engineers, 3 months to MVP.

## State after the second run

| Area | State |
|------|-------|
| Scoring core, decision engine, explainer, log analyzer, memory store | Built, tested (`src/`, 837 lines) |
| Postgres store adapter | Passes the adapter contract on a live PostgreSQL 16 (`test/store.pg.test.js`) |
| HTTP service | Built, tested (`service/app.js`, `test/service.test.js`); also smoke-tested on Postgres |
| Node SDK | Built (`sdk/node/`); passes the conformance suite as `AG_CONFORMANCE_CLIENT` |
| Audit CLI | Built (`scripts/audit.js`) |
| Dockerfile, compose | Written, **never built or run** |
| Golden vectors | 75, all passing (`contracts/golden-vectors.json`) |
| Proof tests | 8, passing on synthetic data (`test/proof.test.js`) |
| Conformance suite | 7 tests against a mock server and reference client (`test/conformance/`) |
| Edge adapters, signal and credential adapters, webhooks, other SDKs | Not built: `docs/BACKLOG.md` |

## Map

| Path | Purpose |
|------|---------|
| `docs/GAP-ANALYSIS.md` | Research, scoring, comparison matrix, proof table |
| `docs/DECISIONS-FOR-HUMAN.md` | Ten calls only a human can make |
| `docs/ARCHITECTURE.md` | Component diagram and ADR-1 to ADR-7 |
| `docs/DECISION-SPEC.md` | Normative rules, weights, thresholds |
| `docs/AGENT-LANE.md` | Agent policy, passes, adapters, assistive protection |
| `docs/PLATFORMS.md` | Compatibility matrix |
| `docs/BACKLOG.md` | Ordered tasks T00-T15 |
| `docs/MANUAL-OUTLINE.md` | Outline of user documentation |
| `docs/ANALYSIS.md` | Substitutes, risks, market size, kill criteria |
| `docs/SCORECARD.md` | Status and measurement for every layer, action, setting, pack and connection; next steps |
| `docs/ACTIONS.md` | What happens after a flag, settings, presets (`service/presets.js`) |
| `docs/VALIDATION.md` | Results on public datasets (`validation/run.js`), and what could not be validated |
| `contracts/` | `openapi.yaml`, `schema.sql`, `golden-vectors.json`, `CONFORMANCE.md` |
| `src/` | Reference core. `index.js` is the only public entry |
| `service/` | HTTP service (`app.js`), live tracker (`liveTracker.js`), presets, entry point, migration |
| `src/features.js` | Request-stream features shared by the log audit and the live tracker. Change it in one place only |
| `sdk/node/` | Thin Node SDK |
| `test/` | `*.test.js`, `synth.js` (seeded generator), `conformance/` |
| `scripts/demo.js`, `scripts/audit.js` | Demo; audit CLI for real log files |

## Commands

```bash
npm test
```

```bash
npm run demo
```

```bash
AG_API_KEYS=acme:dev-key npm start
```

Postgres contract test (needs a database and `npm install --no-save pg`):

```bash
AG_TEST_DATABASE_URL=postgres://ag:ag@localhost:5432/ag_test npm test
```

SDK conformance:

```bash
AG_CONFORMANCE_CLIENT=./sdk/node/index.js node --test test/conformance/conformance.test.js
```

Node 22 or newer. No install step: the core has zero runtime dependencies. `pg` is an optional peer dependency
used only by the Postgres adapter.

## Conventions

- Plain ES modules with JSDoc types (`// @ts-check`); no build step, no TypeScript-only syntax.
- Zero runtime dependencies in `src/`. Tests use `node:test` and built-ins only.
- `src/` holds only the scoring core, engine, explainer, log analyzer and store adapters, capped at 880 lines
  (CI). The service, SDKs and adapters live in their own top-level directories and never contain scoring logic.
- Shared test helpers live in `test/helpers.js`; test files never import each other.
- The engine is pure: no I/O, no clock, no randomness. Same input and config give the same verdict.
- The subject is always `{kind, id}`. Never write code that assumes an account.
- Identifiers are hashed with `hashId(salt, raw)` before storage or transmission. No raw IP, email, key or card
  fingerprint in stores, logs or reports.
- Configuration comes only from `AG_*` environment variables through `loadConfig`; every key has a default.
- Reason codes live in `REASON_TEXT` (`src/explain.js`). Add codes; never rename, reuse or delete one.
- Every claim of "better than" another tool needs a test in `test/proof.test.js` or a Verified cell with a URL.
  Use better / parity / behind per function and say so when behind.
- Documentation states what was run. Anything not executed is labelled as such.
- Document caps are hard and enforced in CI (`caps` job).
- After every round of work, update the build map page (https://claude.ai/artifact/EKnZ8K3SABAV2Ssn6NoMzR): the
  "In simple words" section in plain English and the technical sections (run log, status, validation). Standing
  request from the owner, 2026-11-17.

## Definition of done (every task)

1. `npm test` passes on Node 22; no test is skipped, disabled or weakened to get there.
2. Existing golden-vector outcomes are unchanged, or the change follows the review rule below.
3. New behaviour has a test; new verdict paths have a golden vector.
4. Every non-allow verdict still carries a recovery path; `inconclusive` still only allows or steps up.
5. No new runtime dependency in `src/`.
6. Docs touched by the change are updated and stay under their caps.
7. The task's acceptance criteria in `docs/BACKLOG.md` are met and reported honestly, including what was not run.

## Do not change without human review

- Expected outcomes of existing golden vectors, and `SPEC_VERSION`.
- Weights and thresholds in `src/scoring.js` and their defaults in `loadConfig`.
- The invariants: shadow mode by default; clients fail open; fallback is never a block; provider outage
  downgrades a block; `inconclusive` never blocks, slows or limits; every step-up lists `manual_review`;
  verified search engines and declared assistive tools are never slowed or challenged.
- The assistive-tool exemption bounds (DECISIONS-FOR-HUMAN 5).
- Cross-tenant signals stay off (ADR-5). Per-tenant salts stay per-tenant.
- The wedge (ADR-1) and non-goals: no CAPTCHA solving, no evasion tooling, no resale-market analysis, no
  dashboard UI, no billing implementation, no user accounts of our own.
- Reason-code names and the `Signal` contract fields (type, value, confidence, freshness_s, provenance).
- Any wording that claims an advantage over a named tool (GAP-ANALYSIS.md).

## Known weak points to keep honest about

- "Better" on cluster budgets holds only as one integrated product; appeals and log audit rest on one page read per vendor.
- Accuracy numbers are from invented synthetic populations, plus the limited public-data results in VALIDATION.md.
- Enforcement after a flag exists only in the Node SDK; the rate budget and the live statistics are per process.
- Customers are fitted with settings and presets, never with code written for one customer.
- Linking quality bounds the product; farms with no shared device, card or provider signal look like separate users.
- The assistive declaration is self-asserted.
- An in-house SQL job can reproduce the core idea for a team that already stores device identifiers.
