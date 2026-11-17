# Platform compatibility

Status key: **ran** = executed in this run; **CI** = covered by `.github/workflows/ci.yml` but not yet observed
running; **planned** = backlog task, nothing built.

## Reference core (this repository)

| Runtime | Linux | macOS | Windows | Notes |
|---------|-------|-------|---------|-------|
| Node 22 | ran (22.23.4, x64) | CI | CI | Zero runtime dependencies; `node:test`, `node:crypto`, `node:http`, global `fetch`. |
| Node 24 | CI | CI | CI | |
| Bun, Deno | planned | planned | planned | Core uses only `node:crypto`, `node:fs`, `node:readline`; expected to work, untested. |

Windows risk: the test glob is quoted for `cmd.exe`; log files with CRLF are handled by `readline` (`crlfDelay`).

## Customer backends (thin SDKs; Node built, others planned)

| Language | Adapter | Integration targets | Main risk |
|----------|---------|---------------------|-----------|
| Node/TS (**built**, Connect-style middleware) | `sdk/node`: `assess()`, `track()`, middleware | Vercel, Supabase Edge Functions, Auth0 Actions, Stripe webhooks | Serverless cold starts eat the 150 ms deadline; keep-alive agent needed. |
| Python | `sdk/python`: ASGI/WSGI middleware | FastAPI, Django, LiteLLM callback | Sync frameworks block on the call; use a thread pool with a hard deadline. |
| Go | `sdk/go`: `net/http` middleware | Kubernetes services, API gateways | None specific. |
| Ruby | `sdk/ruby`: Rack middleware | Rails | Default `Net::HTTP` timeouts are coarse; set open and read timeouts separately. |
| Java | `sdk/java`: Servlet filter | Spring Boot | JDK 11+ `HttpClient` required for per-request timeouts. |

All SDKs must pass `contracts/CONFORMANCE.md`. They hash identifiers, call `/v1/decisions`, enforce the deadline and
fall back; no scoring logic lives in an SDK.

## Edge and CDN

| Target | Adapter | Status | Risk |
|--------|---------|--------|------|
| Cloudflare Workers | `edge/cloudflare`: `fetch` handler wrapper; reads verified-bot and signed-agent fields and forwards them as signals | planned | No `node:crypto` HMAC by default: use WebCrypto `HMAC-SHA-256` (same output as `hashId`). Subrequest budget. |
| Vercel Edge Middleware | `edge/vercel` | planned | Same WebCrypto note; 25 s limit irrelevant at a 150 ms deadline. |
| Fastly Compute, Akamai EdgeWorkers | `edge/generic` | planned | Smaller runtime surfaces; may only support log export, not inline. |
| NGINX, Envoy, HAProxy | `auth_request` / `ext_authz` / SPOE against `/v1/decisions` | planned | Maps a non-allow verdict to status and `Retry-After`; cached replies need the proxy cache. |
| Any CDN | Log audit only (`/v1/audits`): CloudFront, Cloudflare Logpush, Fastly, NGINX combined, JSON lines | parser ran on combined and JSON lines | Vendor field names differ; one mapping per vendor (BACKLOG T08). |

Slow actions should run at the edge where possible: a 429 or cached reply at the edge costs the origin nothing.

## Hosting the service

| Target | Status | Notes |
|--------|--------|-------|
| Docker / compose (service + Postgres) | files written, **not built or run** | 12-factor: config only from `AG_*` env vars, logs to stdout, stateless process. |
| AWS (ECS, Lambda), GCP (Cloud Run), Azure (Container Apps) | planned | Postgres 14+ managed service; Lambda needs a connection pooler. |
| Render, Fly.io, Railway, Heroku-style hosts | planned | Single container plus managed Postgres. |
| Postgres 16 | **ran**: adapter contract and a service smoke test on 16.15 | 14 and 17 are covered by CI only. |
| In-memory store | ran | Single process only; for shadow runs and tests. |

## Integration targets

| Target | What the integration does | Status |
|--------|---------------------------|--------|
| Stripe | Radar risk fields to `risk.multi_account`; card fingerprint to a `payment` link; subscription status to `paying` | planned (T07) |
| Auth0 | Post-login/pre-registration Action calls `assess` | planned |
| Supabase | Auth hook plus Edge Function | planned |
| Verisoul, Castle, Stytch, Fingerprint, HUMAN | Signal-provider adapters to the normalized contract | planned (T07) |
| LiteLLM, Cloudflare AI Gateway | Read per-request cost into `/v1/events`; write the cluster verdict back as the budget key | planned (T10) |

## Region notes

Tenant data is pinned to one region. Card-based rungs are weak where cards are uncommon; the ladder order is
configurable per tenant (see ARCHITECTURE.md region notes).
