# Backlog

Ordered. Each task is sized for one session of a mid-tier model. Read `CONTEXT.md` first. Every task ends with
`npm test` green and no change to existing golden-vector outcomes unless the task says so.

## Status (second run, 2026-11-17)

|Task|State|What is left|
|-|-|-|
|T00|Done for one page per vendor|Pricing pages; repeat quarterly|
|T01|Done (`service/`, `test/service.test.js`)|`AG_CONFORMANCE_URL` run against a deployed instance|
|T02|Done (`clusterUsage` in both adapters)|-|
|T03|Done for the client and Connect-style middleware (`sdk/node/`)|Next.js and Fastify wrappers, keep-alive agent, npm packaging|
|T04|Files written (`Dockerfile`, `compose.yaml`, `service/migrate.js`)|**Never built or run**: build, check image size, run `/readyz`|
|T05|Adapter passes the contract on live PostgreSQL 16|Versions 14 and 17 in CI, batched purge, pool tuning under load|
|T08|CLI done (`scripts/audit.js`)|Streaming, gzip, CDN field mappings, rotating-client clustering|
|T06, T07, T09-T15|Not started|Everything|

Third round (same day): error-ratio signal (spec 1.1.0), the action layer and settings/presets are built (`docs/ACTIONS.md`).
Open from it: enforcement in other SDKs and at the edge, a shared rate budget (Redis or the store), stored webhook
deliveries with replay, a real live check behind the `human_check` rung, `charge` and `ask to log in` actions,
and tuning preset numbers with a customer.

Validation on public data is in `docs/VALIDATION.md`. Open follow-up: the blocked datasets (labelled farms, labelled bot logs) once their hosts are reachable.

Known gaps in what was built:

- Pushed signals (`/v1/signals`) and audit reports are kept in process memory, not in the store.
- `signups_per_hour` is not derived from events; the caller must supply it.
- Webhooks, agent passes and signal-provider management answer 501.
- Audit by URL (`AuditRequest.source.url`) answers 501; post the log lines instead.
- `src/` is 718 lines against the original "about 700" cap after adding cluster usage, outcomes and policy to the stores.
- T00 is done for one page per vendor; pricing pages and remaining U cells are still unread.

## T00 Verify the competitor gap (done 2026-11-17 for one page per vendor; repeat quarterly)

- Inputs: `docs/GAP-ANALYSIS.md` matrix and sources.
- Files: `docs/GAP-ANALYSIS.md` only.
- Do: read the full Stripe Radar, Verisoul, Castle, Cloudflare AI Gateway and LiteLLM docs. Replace each U with V (URL) or keep U.
- Accept: no "better" claim rests on a U cell, or the claim is downgraded to parity; file stays under 1,000 words.
- Depends on: nothing.

## T01 HTTP service

- Inputs: `contracts/openapi.yaml`, `test/conformance/mockServer.js`, `src/index.js`.
- Files: `service/server.js`, `service/routes/*.js`, `test/service.test.js`.
- Do: `node:http` server, zero dependencies. Implement `/v1/decisions` (assess, get, explanation, appeal, outcome), `/v1/appeals/{id}`, `/v1/events`, `/v1/subjects`, `/v1/policy`, `/v1/metrics/accuracy`, `/v1/version`, `/healthz`, `/readyz`. Bearer auth from `AG_API_KEYS` (comma-separated `tenant:key`). On assess: load cluster sizes and window usage from the store, merge into `behavior` and `cost`, call `decide`, save the decision.
- Accept: `AG_CONFORMANCE_URL=http://localhost:8787 npm test` passes C1, C2, C6, C7, C8; request body limit 256 KB returns 413 problem; unknown tenant returns 401; p99 under 20 ms on the memory store for 1,000 sequential requests.
- Depends on: nothing.

## T02 Cluster cost aggregation

- Inputs: `src/store/interface.js`, DECISION-SPEC section 2 (cost ratio).
- Files: `src/store/interface.js`, `src/store/memory.js`, `src/store/postgres.js`, `test/store.test.js`, `service/`.
- Do: add `clusterUsage(tenant, subject, windowStart, linkTypes)` returning summed requests and cost over all subjects sharing a device or payment attribute. Service uses it for `cost.usd` when cluster size is 3 or more.
- Accept: contract test where three linked subjects each at $2 yield cluster cost $6; a subject with no links returns its own usage; memory and Postgres adapters agree.
- Depends on: T01.

## T03 Node SDK and middleware

- Inputs: `test/conformance/refClient.js`, CONFORMANCE.md.
- Files: `sdk/node/src/index.js`, `sdk/node/src/express.js`, `sdk/node/package.json`, `sdk/node/README.md`.
- Do: `createClient({baseUrl, apiKey, salt, timeoutMs, failMode})` with `assess`, `track` (batched `/v1/events`), `hash`. Express and Next middleware mapping verdicts to responses: `limit` and `slow` to 429 with `Retry-After`, `cached` to 304, `step_up` to a JSON body with `action`, `block` to 403; shadow mode sets only the `AG-Decision` response header.
- Accept: `AG_CONFORMANCE_CLIENT=./sdk/node/src/index.js npm test` passes all of C1 to C8; middleware test proves no response change in shadow mode; zero runtime dependencies.
- Depends on: T01.

## T04 Docker and compose

- Files: `Dockerfile`, `compose.yaml`, `.dockerignore`, `service/migrate.js`.
- Do: multi-stage image on `node:22-alpine`, non-root user, `HEALTHCHECK` on `/healthz`. Compose with Postgres 16; `migrate.js` applies `contracts/schema.sql` idempotently.
- Accept: `docker compose up` then `curl localhost:8787/readyz` returns 200; image under 150 MB; no secrets in the image.
- Depends on: T01.

## T05 Postgres hardening

- Inputs: `src/store/postgres.js`, `contracts/schema.sql`, `storeContract` in `test/store.test.js`.
- Files: `src/store/postgres.js`, `test/store.pg.test.js`, `.github/workflows/ci.yml`.
- Do: run `storeContract` against real Postgres when `AG_TEST_DATABASE_URL` is set (skip otherwise). Fix whatever fails. Replace the `appeals_by_subject` special case in `eraseSubject` with explicit statements. Add a CI job with a Postgres service for versions 14 and 17. Add statement timeout (`AG_PG_STATEMENT_TIMEOUT_MS`, default 200) and pool size env vars.
- Accept: contract passes on both versions; `EXPLAIN` of `clusterSize` uses `subject_links_by_subject`; purge of 1M decisions completes in batches without a table lock longer than 1 s.
- Depends on: T04.

## T06 Edge middleware (Cloudflare Workers, Vercel)

- Inputs: PLATFORMS.md edge table, T03 client.
- Files: `edge/cloudflare/src/index.js`, `edge/vercel/middleware.js`, `edge/README.md`, `test/edge.test.js`.
- Do: WebCrypto `hashId` with output identical to `src/scoring.js`. Forward the platform's verified-bot and signed-agent fields as `bot.verified` and `agent.credential` signals. Apply slow actions at the edge.
- Accept: hash parity test on 20 inputs; verified search engine is never slowed; origin is not contacted for 429 and cached replies.
- Depends on: T03.

## T07 Signal-provider adapters

- Inputs: `openapi.yaml#Signal`, DECISION-SPEC section 1.
- Files: `adapters/signals/{stripe_radar,verisoul,castle,stytch,fingerprint,ip_intel}.js`, `test/adapters.test.js`, `docs/adapters.md`.
- Do: each adapter is a pure function from the provider's documented response to `Signal[]`, plus a fetch wrapper with a 150 ms deadline that reports `ok | timeout | down`. Use only fields in the provider's public docs; record the doc URL in the file header.
- Accept: fixture-based tests per adapter; a provider timeout produces `providers.<name> = timeout` and no exception; no adapter imports the engine.
- Depends on: T01.

## T08 Log-audit report generator and CDN mappings

- Inputs: `src/logAnalyzer.js`, MANUAL-OUTLINE section 5.
- Files: `scripts/audit.js`, `src/logFormats.js`, `test/logFormats.test.js`.
- Do: CLI `node scripts/audit.js <file|-> [--format auto|clf|jsonl|cloudfront|cloudflare|fastly] [--robots robots.txt] [--endpoint-cost prefix=usd] [--out report.md|json]`. Stream the file (replace the in-memory array in `analyzeFile`), support gzip. Add rotating-client clustering: group sessions by user agent plus path-sequence similarity into a `device_cluster` subject.
- Accept: 5 GB log in under 2 GB of memory; mapping tests with three sample lines per CDN format; report has no raw IPs or keys; `src` stays within the line cap or the new code lives outside `src`.
- Depends on: nothing.

## T09 Agent passes and credential adapters

- Inputs: AGENT-LANE.md, `openapi.yaml` agent paths, vectors `agent-*`.
- Files: `service/routes/agents.js`, `adapters/credentials/{ag_pass,web_bot_auth}.js`, `test/agents.test.js`.
- Do: issue, verify and revoke passes (HMAC token, hashed at rest, bound to subject, agent and key thumbprint, TTL at most 900 s). Web Bot Auth adapter verifies an HTTP Message Signature against a configured key directory using `node:crypto`; record the draft revision in `provenance`.
- Accept: a pass replayed with a different client key fails; an expired pass yields vector `agent-10` behaviour; signature test vectors from the draft pass; adapter failure yields an unverified agent, never an exception.
- Depends on: T01.

## T10 Shadow-mode report and gateway bridge

- Files: `service/routes/reports.js`, `adapters/gateways/{litellm,cloudflare_ai_gateway}.js`, `test/reports.test.js`.
- Do: weekly shadow report per tenant: cost by class, dollars that enforcement would have saved, top clusters, flagged paying users, appeal outcomes. Gateway adapters read per-request cost into `/v1/events` and document how to pass the cluster id as the gateway's budget key.
- Accept: report totals equal the sum of stored usage; a tenant with zero labels shows precision as `null`, not 0.
- Depends on: T02.

## T11 Python, Go, Ruby, Java SDKs

- Files: `sdk/{python,go,ruby,java}/`.
- Do: port the Node SDK surface; port `conformance.test.js` to each native runner reading `contracts/golden-vectors.json`.
- Accept: each SDK passes C1 to C8 in CI against the Docker image from T04.
- Depends on: T03, T04.

## T12 Marketplace plugins

- Files: `plugins/{stripe-app,auth0-action,supabase,vercel-integration}/`.
- Do: thin wrappers over the Node SDK with install docs.
- Accept: each has a local test with mocked platform events; none stores a secret outside the platform's secret store.
- Depends on: T03, T07.

## T13 Docs

- Inputs: MANUAL-OUTLINE.md.
- Files: `README.md`, `docs/manual/*.md`.
- Do: write the manual from the outline. Every command in the docs is executed in CI.
- Accept: a new engineer gets a shadow verdict from the README in under 15 minutes; no claim appears that is not in GAP-ANALYSIS.md.
- Depends on: T01, T03, T08.

## T14 Demo

- Files: `demo/`, `scripts/demo.js`.
- Do: compose stack with a sample API that has an expensive endpoint, a farm simulator and a campus simulator hitting it, and the shadow report after five minutes.
- Accept: one command; output shows dollars caught and zero campus users blocked.
- Depends on: T04, T10.

## T15 Phase 2 hooks (design only)

- Files: `docs/PHASE-2.md`.
- Do: open questions for anonymous traffic (guest checkout, ticket queues, public APIs, form spam): what the subject is without an account, which link attributes are lawful, queue fairness. No code.
- Depends on: three pilots completed.
