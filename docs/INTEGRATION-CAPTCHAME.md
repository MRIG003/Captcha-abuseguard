# Adding abuseguard as the second layer of CaptchaMe

This guide tells the CaptchaMe team how to add abuseguard (package 0.4.0) behind CaptchaMe.

**Order of layers:**

1. CaptchaMe checks that a live person or a declared agent is present. It issues the pass token.
2. abuseguard decides how much that visitor can use. It applies the fair share and the actions after a flag.

**What was verified.** The CaptchaMe repository is not on the machine where abuseguard was built. These steps come from
the CaptchaMe briefing. The file `test/captchame-integration.test.js` makes the exact abuseguard calls that these
steps describe, and all of them pass (142 tests). The CaptchaMe code itself has **not** been tested with
abuseguard. Items marked **(assumed)** come from the briefing, not from the code.

## 1. Decisions to make first

| # | Decision | Recommendation | Why |
|---|---|---|---|
| D1 | Who owns the fair-share money? | abuseguard decides. CaptchaMe keeps presence and agent checks only. CaptchaMe's ledger stops making limit decisions. | Two ledgers would count the same call twice and disagree. |
| D2 | Which budget window? | Set `window_s` in the policy. Use 86400 (one day) to start. | CaptchaMe's ledger is lifetime. abuseguard resets each window. |
| D3 | What happens when abuseguard does not answer? | Fail open for `/quote`, but keep the CaptchaMe pass check. Log every fail-open. | Blocking all paid calls during an outage hurts real users more than a short lapse in limits. |
| D4 | Where does abuseguard run? | As one long-running service (Docker on Render, Fly, or a VM). **Not** inside Vercel functions. | Live statistics live in one process's memory. Vercel runs many instances, so each would see only a slice of traffic. |
| D5 | How is an agent's proof kept fresh? | CaptchaMe sends the agent signal with its real age. Proofs older than 5 minutes are ignored (see gap G3). | abuseguard ignores credentials older than 300 seconds. |

## 2. Set up abuseguard

1. Unzip `abuseguard-0.4.0.zip`. It needs Node 22 or newer. Nothing is installed.
2. Start the service. Use one instance only.

```bash
AG_API_KEYS="captchame:<long-random-key>" AG_MODE=shadow PORT=8787 npm start
```

For storage that survives restarts, set `DATABASE_URL` and run `npm run migrate` first. This needs `npm install --no-save pg`.

3. Use one tenant key per customer site. Do not share one key between sites. This answers the briefing's weakness #3 (the `data-site` key is only cosmetic).

## 3. Set the policy once

Run this when the service starts, or from an admin script:

```js
// Once per tenant. Plans match the context.plan value that CaptchaMe sends.
await fetch(`${AG_URL}/v1/policy`, {
  method: 'PUT',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${AG_KEY}` },
  body: JSON.stringify({
    preset: 'ai_app',                 // starting values for a free AI product
    strictness: 'watch',              // watch = record only. Move to gentle, then strict, later.
    window_s: 86400,                  // decision D2
    budget_usd: 0.5,                  // default for anything without a plan match
    budgets: [
      { match: { plan: 'anonymous' }, budget_usd: 0.5 },   // CaptchaMe anonymous default
      { match: { plan: 'human' },     budget_usd: 2 },     // CaptchaMe human default
      { match: { plan: 'agent' },     budget_usd: 1 },     // CaptchaMe agent default
    ],
    trap_paths: ['/trap'],            // CaptchaMe honeypot
    endpoint_costs: [{ prefix: '/api/protected/quote', usd: 0.10 }],
  }),
});
```

## 4. Add the client to CaptchaMe

Copy `sdk/node/index.js` into CaptchaMe, for example to `lib/abuseguard.js`. It has no dependencies.

Set three environment variables in CaptchaMe:

- `ABUSEGUARD_URL`: the address of the service from step 2.
- `ABUSEGUARD_KEY`: the tenant key from step 2.
- `ABUSEGUARD_SALT`: a random secret. Keep it on the server only. It hashes every identifier before it is sent.

```js
// lib/abuseguard.js (in CaptchaMe)
import { createClient } from './sdk-abuseguard.js';
export const ag = createClient({
  baseUrl: process.env.ABUSEGUARD_URL,
  apiKey: process.env.ABUSEGUARD_KEY,
  salt: process.env.ABUSEGUARD_SALT,
  timeoutMs: 300,          // a little longer than the 150 ms default, because CaptchaMe is serverless
  failMode: 'open',        // decision D3
});
// Subject for a CaptchaMe actor. The raw actor id is hashed and never leaves CaptchaMe.
export const subjectOf = (actor) => ag.subject('session', actor);
```

**Important.** Only the CaptchaMe server may call abuseguard. Never send abuseguard calls from the browser. abuseguard
trusts the signals that its caller sends. A browser could claim a human pass that it never earned.

## 5. Step by step: where each call goes

### Step A. A challenge passes

CaptchaMe already scores the pass. Keep that code. Do not send anything to abuseguard yet. The next call sends the
pass as a signal (step B).

### Step B. A visitor asks for a paid call (`/api/protected/quote`)

Order matters. Decide first, then serve, then record the cost.

```js
// In the /quote handler, after CaptchaMe has checked the pass token or the agent token.
const actor = verifiedActorFromToken;              // from CaptchaMe, never from the request body
const subject = subjectOf(actor);
const kind = verifiedKind;                         // 'human', 'anonymous' or 'agent'
const pass = passAgeSeconds < 300;                 // freshness: the pass token lives 5 minutes

const verdict = await ag.assess({
  subject,
  mode: 'enforce',
  context: { surface: 'api', endpoint_class: 'expensive', plan: kind },
  request: { path: '/api/protected/quote', ua: req.headers['user-agent'] ?? '' },
  signals: pass && kind === 'human'
    ? [{ type: 'human.liveness', value: 'pass', confidence: 0.9, freshness_s: passAgeSeconds, provenance: 'captchame' }]
    : kind === 'agent'
      ? [{ type: 'agent.credential', value: { scheme: 'captchame-ed25519', agent_id: agentId, verified: true, user_bound: boundToUser }, confidence: 0.95, freshness_s: proofAgeSeconds, provenance: 'captchame' }]
      : [],
});

if (verdict.enforced && verdict.decision === 'limit') {
  return res.status(429).json({
    error: 'budget_exceeded',
    reason: verdict.reasons,                       // plain codes; map them to text in the UI
    retry_after_s: verdict.action.retry_after_s,
    remaining_usd: verdict.cost.budget_usd - verdict.cost.attributed_usd,
    appeal_url: '/api/appeal',
    decision_id: verdict.decision_id,              // keep this: the appeal needs it
  });
}

const quote = await serveQuote();                   // the existing fake or real quote
await ag.track({ type: 'usage', subject, usage: { requests: 1, direct_usd: 0.10 } });
return res.json({ quote, charged: 0.10, remaining_usd: verdict.cost.budget_usd - verdict.cost.attributed_usd - 0.10 });
```

Notes:

- `decision_id` must be stored with the appeal, or in the ledger record. CaptchaMe's ledger does not store it today.
- In `watch` mode the verdict is still returned. `verdict.enforced` is `false`. The example above then serves the quote.
- The 429 body keeps the CaptchaMe error text (`budget_exceeded`). Only the reason values change.

### Step C. A visitor gets a step-up

If the verdict says `step_up` with `action.step === 'human_check'`, CaptchaMe runs its own check. On a pass:

```js
await ag.verify(subjectOf(actor), 'human_check', 'pass');   // POST /v1/subjects/session/{id}/verifications
```

The next decision for that subject moves on. Send the pass as a signal as well (step B), because the verification
is kept in the service's memory (decision D4).

### Step D. An appeal

CaptchaMe's `/api/appeal` forwards the appeal to abuseguard:

```js
await fetch(`${AG_URL}/v1/decisions/${decisionId}/appeal`, {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${AG_KEY}` },
  body: JSON.stringify({ channel: 'api', note: message.slice(0, 2000) }),
});
```

When the admin approves in the CaptchaMe dashboard, call:

```js
await fetch(`${AG_URL}/v1/appeals/${appealId}`, {
  method: 'PATCH', headers: { 'content-type': 'application/json', authorization: `Bearer ${AG_KEY}` },
  body: JSON.stringify({ outcome: 'overturned' }),   // or 'upheld'
});
```

An overturned appeal clears blocks and challenges for 30 days. It does **not** raise the budget. CaptchaMe's
"+$1 on approval" has no equivalent yet (gap G1).

### Step E. Honeypot

The honeypot link `/trap` is already in the policy (step 3). Each request that reaches the middleware is counted
automatically. Make sure the middleware is mounted before the honeypot route. CaptchaMe's trap route should also call:

```js
await ag.track({ type: 'request', subject: subjectOf(actor), request: { path: '/trap', ua: req.headers['user-agent'] ?? '', status: 200 } });
```

### Step F. Watching decisions in the CaptchaMe dashboard

abuseguard sends signed events to a web address that the CaptchaMe team chooses. Register it once:

```js
await fetch(`${AG_URL}/v1/webhook-endpoints`, {
  method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${AG_KEY}` },
  body: JSON.stringify({ url: 'https://captchame.example/api/abuseguard-events', events: ['subject.flagged', 'appeal.filed', 'appeal.resolved'] }),
});
```

The reply contains a `secret` once. Store it. Check every message like this:

```js
import { createHmac, timingSafeEqual } from 'node:crypto';
export function verifyAbuseguardEvent(rawBody, header, secret) {
  const m = /^t=(\d+),v1=([0-9a-f]+)$/.exec(header ?? '');
  if (!m || Math.abs(Date.now() / 1000 - Number(m[1])) > 300) return false;   // reject old messages
  const expected = createHmac('sha256', secret).update(`${m[1]}.${rawBody}`).digest();
  const given = Buffer.from(m[2], 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
```

The webhook URL must be HTTPS and must not point at a private address (set `AG_WEBHOOK_ALLOW_PRIVATE=1` only for local tests).

## 6. What maps to what

| CaptchaMe | abuseguard | Note |
|---|---|---|
| `pop_actor` cookie (`human:<hex>`) | `subject` (`session`, hashed) | Same identity. The raw value stays in CaptchaMe. |
| Anonymous, human, agent defaults | `budgets` by `plan` | Plan names must match `context.plan`. |
| Pass token (5 minutes) | `human.liveness` signal | Send the age as `freshness_s`. |
| Agent declaration | `agent.credential` signal | Freshness limit 300 seconds (gap G3). |
| `ledger.spend` | `track({type:'usage'})` after the quote is served | Dollars go to `direct_usd`. |
| Budget left | `cost.budget_usd − cost.attributed_usd` | Computed by the caller. |
| `/api/appeal` | `POST /v1/decisions/{id}/appeal` | Needs the stored `decision_id`. |
| Admin approve (+$1) | `PATCH /v1/appeals/{id}` (trust only) | Gap G1. |
| `/trap` event | `trap_paths` plus the middleware's request report | |
| Dashboard event feed | Signed webhooks | Verify every message. |
| Ring, beat, reflex, voice scoring | Not used | abuseguard has no behaviour layer. CaptchaMe keeps it. |

## 7. Gaps to close before go-live

| # | Gap | Effect | Fix |
|---|---|---|---|
| G1 | No per-person budget grant | CaptchaMe's +$1 appeal has no equivalent | Add `POST /v1/subjects/{kind}/{id}/grants` that raises one subject's budget for one window. About 1 day of work. |
| G2 | Live state is per process | Several servers see only part of a visitor's traffic | Store live counters in Redis or Postgres. Required if D4 is not accepted. |
| G3 | Agent proofs older than 5 minutes are ignored | An agent that holds a token for an hour is treated as unverified | CaptchaMe re-proves on each call, or the proof is extended. Decide with the agent lane owner. |
| G4 | abuseguard trusts caller signals | A compromised CaptchaMe server could send fake passes | Keep abuseguard keys on the server only. Log every signal source. |
| G5 | Verifications are kept in memory | A restart forgets a passed check | Send the pass as a signal on every call (step B). Persist verifications in Postgres later. |
| G6 | Device links come from the caller only | Farms with no shared device or card look like separate people | CaptchaMe sends a hashed device identifier as a `link` event if it collects one. |

## 8. Rollout

1. **Week 1, watch mode.** `strictness: 'watch'`. CaptchaMe serves exactly as today. Compare abuseguard's verdicts
   with CaptchaMe's ledger in the logs. Expect differences.
2. **Week 2, gentle.** `strictness: 'gentle'`. Limits are enforced, but nothing is blocked. Watch appeal volume.
3. **Week 3 onward, strict.** Only after appeal volume and false-alarm rate are acceptable. Set `strictness: 'strict'`.

Stop and go back to watch mode if more than 1% of paying users are limited without a reason, or if appeals are not
answered within 24 hours.

## 9. Checks before you deploy

```bash
npm test
```

From the abuseguard package, this runs 142 tests, including the CaptchaMe call checks. Then run the same checks
against the real CaptchaMe deployment in staging: one anonymous visitor, one human, one agent, one trap hit, one
appeal, and one webhook.

## 10. Blocking decisions

Do not go live until D1 and D4 are answered. D1 decides who owns the budget. D4 decides whether the live statistics
can be trusted on Vercel. If D4 is "Vercel", G2 must be built first.
