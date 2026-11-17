# Manual outline

Written in BACKLOG T13. Each bullet is a section.

## 1. README (one page)

- What it does in two sentences; who it is for; what it is not (no CAPTCHA, no detector).
- Quick start: `npm run demo`, then a shadow verdict with `curl` against the Docker image.
- The audit in three commands.
- Status table: built, planned, not verified.
- Links to the guides below.

## 2. Operator guide (person running it for a company)

- Concepts: subject, link, cluster, budget window, verdict classes, decisions, ladder.
- Rollout: audit, shadow mode for two weeks, review the shadow report, enforce one surface at a time.
- Setting budgets: per plan and endpoint class; how cluster cost is attributed; cost rates.
- Reading a verdict: reason codes, confidence, what `inconclusive` means.
- Appeals: where they arrive, the 24-hour target, what overturning does.
- Accuracy report: precision, paying false positives, overturn rate; how to add outcome labels.
- Shared networks, assistive tools and agents: what is exempt and why.
- Incidents: provider or engine outage, a wrongly limited customer, a leaked key.
- Privacy duties: retention, erasure requests, regional pinning, DPA checklist.
- Accessibility checklist toward WCAG 2.2 AA, EAA and ADA: every step-up has a non-visual, non-gesture, non-camera path; error text is plain; time limits are extendable; no step depends on colour, pointer or audio alone.

## 3. Implementer guide (engineer integrating it)

- Choosing the subject for each surface.
- Sending link events (device, payment, IP, email domain) and usage events with cost.
- Inline: SDK middleware per language; mapping decisions to HTTP responses; the 150 ms deadline and fail-open.
- Batch: log upload and field mappings per CDN.
- Signal providers: enabling an adapter; what happens when one is slow.
- Agents: issuing passes, policies, the agent plan (AGENT-LANE.md).
- Testing an integration: golden vectors and the conformance suite.

## 4. API and configuration reference

- Generated from `contracts/openapi.yaml`: endpoints, schemas, errors, auth, webhooks and signature check, versioning.
- Reason-code table generated from `REASON_TEXT`.
- Environment variables, one table, generated from `loadConfig`:

|Group|Variables|
|-|-|
|Mode|`AG_MODE` (shadow), `AG_FAIL_MODE` (open)|
|Farm|`AG_FARM_BLOCK` (0.85), `AG_FARM_STEP_UP` (0.5)|
|Scraper|`AG_SCRAPER_SLOW` (0.6), `AG_SCRAPER_WATCH` (0.35), `AG_RPM_HIGH` (120), `AG_RPM_VERY_HIGH` (600)|
|Signals|`AG_SIGNAL_MAX_AGE_S` (86400), `AG_SIGNAL_MIN_CONFIDENCE` (0.3)|
|Rates|`AG_AGENT_RPM` (60), `AG_CRAWLER_RPM` (60), `AG_SLOW_RPM` (30), `AG_RETRY_AFTER_S` (60), `AG_KEY_FANOUT` (25)|
|Budget|`AG_BUDGET_USD` (5), `AG_BUDGET_WINDOW_S` (86400)|
|Cost|`AG_COST_PER_CPU_S` (0.00005), `AG_COST_PER_GB` (0.08), `AG_COST_PER_DB_S` (0.0001)|
|Appeals|`AG_APPEAL_SLA_HOURS` (24)|

- Store adapters and the schema.
- Changelog and spec-version policy.

## 5. Bot load and cost audit (one page)

Goal: a dollar figure from existing logs in under an hour, with nothing installed in the request path.

1. Export 7 to 30 days of access logs (combined format or JSON lines) from the server or CDN. Include request time and bytes if available.
2. Collect three inputs: `robots.txt` Disallow prefixes, the list of expensive endpoints with an estimated dollar cost per call, and the paths that mean a conversion.
3. Run the audit locally (`scripts/audit.js`, T08) or upload to `/v1/audits`. IPs and keys are hashed on read; raw values are not stored.
4. Read the report: cost by class, top subjects by cost, estimated savings by action, good traffic converted.
5. Sanity-check ten top subjects by hand against your own records. Record any that are wrong.
6. Decide: which surface to put into shadow mode first, and the starting budget.

What the audit cannot see: device and payment links (so farms are undercounted), anything not in the logs, and whether a declared bot is genuine unless a verifier is supplied.
