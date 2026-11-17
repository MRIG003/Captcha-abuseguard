# abuseguard

A traffic referee for companies whose free tiers and expensive endpoints are drained by people running many
accounts or API keys. It caps dollars **per person, across all the accounts and keys linked to them**, explains
every verdict, and always gives a wrongly limited user a way back.

It is not a CAPTCHA and not a bot detector. It uses the signals you already have (your own usage data, plus
Stripe Radar, Verisoul and similar if you run them) and decides who gets in, how much they get, and what happens
when they run out.

Defensive use only: it protects your own resources.

## Try it in two minutes

Requires Node 22 or newer. Nothing to install.

```bash
npm run demo
```

Prints a bot load and cost audit of synthetic logs and three explained verdicts.

```bash
npm test
```

## Audit your own logs (no integration)

```bash
node scripts/audit.js access.log --disallow /private/ --endpoint-cost /api/generate=0.02 --converted /checkout/complete
```

Reads combined-format or JSON-lines access logs and prints cost by traffic class, the most expensive subjects and
an estimate of what bounded actions would have saved. IPs and API keys are hashed on read. Nothing is enforced.
`--help` lists the options. What the audit cannot see is listed in `docs/MANUAL-OUTLINE.md` section 5.

## Run the service

```bash
AG_API_KEYS=acme:a-long-random-key npm start
```

Without `DATABASE_URL` it uses an in-memory store (data is lost on restart). For Postgres:

```bash
npm install --no-save pg
```

```bash
DATABASE_URL=postgres://user:pass@localhost:5432/abuseguard npm run migrate
```

```bash
DATABASE_URL=postgres://user:pass@localhost:5432/abuseguard AG_API_KEYS=acme:a-long-random-key npm start
```

Or with Docker (Postgres included); put `AG_API_KEYS=acme:a-long-random-key` in a `.env` file first:

```bash
docker compose up --build
```

## First decision

Tell the service that three API keys share a device and each spent $2.50, then ask about one of them:

```bash
curl -s localhost:8787/v1/events -H 'authorization: Bearer a-long-random-key' -H 'content-type: application/json' -d '{"events":[
 {"type":"link","subject":{"kind":"api_key","id":"k1"},"link":{"link_type":"device","value_hash":"d1"}},
 {"type":"link","subject":{"kind":"api_key","id":"k2"},"link":{"link_type":"device","value_hash":"d1"}},
 {"type":"link","subject":{"kind":"api_key","id":"k3"},"link":{"link_type":"device","value_hash":"d1"}},
 {"type":"usage","subject":{"kind":"api_key","id":"k1"},"usage":{"direct_usd":2.5}},
 {"type":"usage","subject":{"kind":"api_key","id":"k2"},"usage":{"direct_usd":2.5}},
 {"type":"usage","subject":{"kind":"api_key","id":"k3"},"usage":{"direct_usd":2.5}}]}'
```

```bash
curl -s localhost:8787/v1/decisions -H 'authorization: Bearer a-long-random-key' -H 'content-type: application/json' -d '{"subject":{"kind":"api_key","id":"k1"}}'
```

Each key is under the $5 default budget; together they spent $7.50, so the verdict is `limit` with reasons
`DEVICE_CLUSTER` and `COST_OVER_BUDGET` and a recovery path. The service starts in **shadow mode**: the verdict is
recorded, `enforced` is `false`, and nothing is blocked until you set `AG_MODE=enforce` or the tenant policy.

## Use it from a Node backend

```js
import { createClient } from './sdk/node/index.js';

const ag = createClient({ baseUrl: 'http://localhost:8787', apiKey: process.env.AG_KEY, salt: process.env.AG_SALT });

// Tell abuseguard what links subjects together and what they cost you.
ag.track({ type: 'link', subject: ag.subject('api_key', apiKey), link: { link_type: 'device', value_hash: ag.hash(deviceId) } });
ag.track({ type: 'usage', subject: ag.subject('api_key', apiKey), usage: { direct_usd: costOfThisCall } });

// Guard an expensive route (Express/Connect style). In shadow mode it only sets the AG-Decision header.
app.use('/api/generate', ag.middleware((req) => ({
  subject: ag.subject('api_key', req.get('x-api-key')),
  context: { surface: 'api', endpoint_class: 'expensive' },
})));
```

The SDK hashes identifiers before they leave your process, waits at most 150 ms, and fails open.

The middleware also tells the service about each request and how it ended (path, client type, status, size,
time). From that the service works out request rate, error share, page-order patterns and timing for each
visitor on live traffic, so a scraper is flagged while it is still running. For visitors with no account:

```js
app.use(ag.middleware((req) => ({
  subject: ag.subject('session', `${req.ip}|${req.get('user-agent')}`),
  context: { surface: 'content' },
})));
```

Set `robots_disallow`, `trap_paths` and `endpoint_costs` in the policy to add robots.txt, trap-link and cost
evidence. Live statistics are held in the service's memory: with several instances each sees only its share.

## Configuration

Environment variables only. The service needs `AG_API_KEYS` (`tenant:key`, comma-separated); `PORT` (8787),
`DATABASE_URL`, `AG_LIVE_MAX_SUBJECTS` (100000), `AG_LIVE_IDLE_S` (3600), `AG_MODE` (`shadow`), `AG_BUDGET_USD` (5) and `AG_BUDGET_WINDOW_S` (86400) are the ones most
people change. The full table with defaults is in `docs/MANUAL-OUTLINE.md` section 4; the code is `loadConfig`
in `src/scoring.js`. Per-tenant budgets, mode and agent policies are set through `PUT /v1/policy`.

## Status

| Part | State |
|------|-------|
| Scoring core, decision engine, explainer, log analyzer | Built and tested, 75 golden vectors |
| Rate, pattern and timing signals on live traffic | Built and tested; replayed on public logs (`docs/VALIDATION.md` E5). State is per process |
| Actions after a flag (step-up loop, appeals, trust, signed webhooks, rate budget in the SDK) | Built and tested (`docs/ACTIONS.md`) |
| Settings and presets (strictness, allowed actions, check order, nine presets) | Built and tested; preset numbers are untuned starting points |
| HTTP service (decisions, appeals, outcomes, events, subjects, policy, agent policies, signals, audits, accuracy) | Built and tested |
| Store adapters | Memory: tested. Postgres: passes the adapter contract on a live PostgreSQL 16 |
| Node SDK | Built; passes the conformance suite |
| Audit CLI | Built; loads the file into memory (large files: backlog T08) |
| Dockerfile and compose | Written, **not built or run** (no Docker daemon where this was authored) |
| Agent passes, signal-provider adapters, edge adapters, other SDKs | Specified in the contract, **not built** (the API answers 501) |
| CI on macOS, Windows, Node 24 | Configured, not yet observed running |

Accuracy figures in `docs/GAP-ANALYSIS.md` come from synthetic data. `docs/VALIDATION.md` reports runs on public
logs and usage traces; nothing has been run on a customer's traffic.

## Where things are

- `CONTEXT.md` - start here to continue the build.
- `docs/GAP-ANALYSIS.md` - what existing tools do, where this is better, at parity or behind.
- `docs/DECISION-SPEC.md` - the rules. `contracts/golden-vectors.json` - the test vectors that pin them.
- `contracts/openapi.yaml` - the API. `contracts/CONFORMANCE.md` - what every SDK must pass.
- `docs/SCORECARD.md` - status and measurement for every part of the plan, and what to do next.
- `docs/ACTIONS.md` - what happens after a flag, the settings and the presets.
- `docs/VALIDATION.md` - results on public datasets and what is still unproven.
- `docs/DECISIONS-FOR-HUMAN.md` - open decisions. `docs/BACKLOG.md` - what is left.
