# What happens after a flag

A verdict alone changes nothing. This page lists what the product does once a subject is flagged, who does it,
and how a company fits it to its business with settings. Rules and thresholds are in DECISION-SPEC.md.

## Principles behind the choices

1. **Cost the abuser, not the customer.** Prefer actions that remove the benefit (a cap, a slower lane) over
   actions that risk locking out a real person.
2. **Proportional.** The response grows with the evidence: unclear cases get one small step, strong linked
   evidence gets a block.
3. **Reversible.** Every action has a way back, and using it changes the next decision.
4. **Watch first.** Nothing is enforced until the company switches it on.
5. **Settings, never custom code.** If a customer needs something the settings cannot do, it becomes a setting
   for everyone.

## The actions

| Flag | Action taken | Who carries it out | How it ends |
|---|---|---|---|
| Over the fair share (`limit`) | 429 with `Retry-After` until the window resets | SDK middleware | Window resets, user adds a payment method, or upgrades |
| Suspected scraper (`slow`, rate budget) | 30 requests a minute pass, the rest get 429 | SDK token bucket | Client identifies itself, or slows down |
| Re-fetching unchanged pages (`slow`, cached) | Conditional requests get 304; others fall under the rate budget | SDK middleware | Same |
| Very aggressive (`slow`, retry-after) | 429 with a 60-second `Retry-After` | SDK middleware | Same |
| Unclear case (`step_up`) | One check from the ladder: email, passkey, card, live check, manual review | The company's app, through the `onStepUp` hook | App reports the result to `POST /v1/subjects/{kind}/{id}/verifications`; the next decision moves on |
| Linked farm, strong evidence (`block`) | 403 with recovery paths | SDK middleware | Appeal or manual review |
| Any flag | Signed webhook `subject.flagged` to the company (once per subject and decision per 10 minutes) | Service | - |

What follows a flag:

- **Step completed.** The subject's record is updated (confirmed email, passkey, own card, passed live check).
  The same request is then scored again with that evidence.
- **Appeal filed.** While it is open, a block is replaced by a step-up, so a wrongly blocked person is not locked
  out while waiting. Webhook `appeal.filed`.
- **Appeal overturned, or manual review passed.** The subject is trusted for 30 days: challenges, slow-downs and
  blocks are switched off. The fair-share limit still applies. Webhook `appeal.resolved`.
- **Appeal upheld.** The original action returns.
- **Labels.** `POST /v1/decisions/{id}/outcome` records what really happened; the accuracy report uses it.

Not done automatically, on purpose: deleting accounts, revoking API keys, refunding or charging, and reporting
anyone. Those stay with the company and can be triggered from the webhook.

## Settings (per company, through `PUT /v1/policy`)

| Setting | Field | Effect |
|---|---|---|
| How strict | `strictness`: `watch`, `gentle`, `strict` | Watch records only. Gentle enforces but never blocks. Strict enforces everything |
| Allowed actions | `allowed_actions` | An action the company does not use is replaced by a lighter one |
| Which check when unsure | `step_up_order` | Order of the ladder; manual review always stays as the last option |
| One person's fair share | `budget_usd`, `window_s`, `budgets[]`, `unit` | The cap, its period, per-plan overrides, and what is counted (dollars, items, tickets, pages) |
| Rules per visitor type | `agents`, `thresholds` | Per-agent allow, deny, scope and rate; crawler rate |
| Alerts | `PUT /v1/webhook-endpoints` | Where signed events go |
| Cost numbers | `AG_COST_*`, `usage.direct_usd`, `usage.amount` | What a request costs, for the savings figure |

## Presets

`GET /v1/presets` lists them; `PUT /v1/policy {"preset": "ticketing"}` applies one. All start in watch mode. The
numbers are starting points, not tuned values. Four job-based packs were added from the plan document
(`scraper_blocking`, `anti_spying`, `attack_defence`, `general`); see `service/presets.js`.

| Preset | Protects | Fair share counted in | First check | Actions allowed | Agents |
|---|---|---|---|---|---|
| `ai_app` | Signup, API | Dollars of compute per day | Email | Step-up, slow, limit, block | Allowed, rate-limited |
| `online_store` | Signup, pages | Items per day | Email | Step-up, slow, limit | Read only |
| `ticketing` | Signup, purchase | Tickets per week | Live check | Step-up, limit, block | Denied |
| `publisher` | Pages | Pages per hour | Proof of work | Slow, limit | Read only, slower crawl rate |
| `rewards_app` | Signup | Bonuses per month | Passkey | Step-up, limit, block | Denied |

## Limits of what is built

- The live check is a slot (`human.liveness` signal and the `human_check` rung). No live check is built into
  this repository; the prototype mentioned in planning is not part of it.
- "Charge" is not an action yet; it needs a billing integration. "Ask to log in" is a rung a company can place
  first with `step_up_order: ["login", ...]`; the login itself is the company's.
- Enforcement lives in the Node SDK only. Other languages and edge workers must port the same mapping.
- The rate budget is per process. Behind several servers each keeps its own bucket.
- Webhook delivery is best effort (three attempts) and is not stored for replay. Private and non-HTTPS targets
  are refused; DNS names that resolve to private addresses are not detected.
- `unit` relabels the count; the engine's field names still say dollars.
- Segments such as surveys, exams and card testing need signals the core does not collect yet.
