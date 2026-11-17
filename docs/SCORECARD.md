# Scorecard

Where the product stands against the plan in "Our Product, Start to Now: Knowing Who Is Visiting" (17 Nov 2026),
part by part, with the measurement behind each claim. Updated 2026-11-17, decision spec 1.2.0.

Status words: **Built** = in this repository and tested. **Partial** = some of it built. **Slot** = the place to
plug it in exists, the thing itself does not. **Not built**.

Evidence words: **Public data** = run on real, public datasets (VALIDATION.md). **Synthetic** = invented data
(`test/proof.test.js`). **Tests only** = behaviour is pinned by tests, with no accuracy measurement.

## Two things the plan document gets wrong about this repository

- It lists layers 1 to 5, identity linking, usage and cost, fair-share limits, settings, packs and the log report
  as "designed, not built". They are built here (see below).
- It lists the live reaction check, its server scoring and its 14 tests as built. None of that is in this
  repository. Only the slot for it exists.

## A. Signal layers

| # | Layer | Status | What exists | Measurement |
|---|---|---|---|---|
| 1 | Network | Slot | Accepts `network.proxy` and `network.shared_env` signals from an IP-data provider; collects nothing itself | Synthetic: shared-network users blocked or slowed 0%, asked for a step 2.45% |
| 2 | Connection type | Partial | User-agent structure; the contradiction "says browser, loads no assets". No TLS or header fingerprint | Public data: 96.9% of 2,125 crawler user-agents seen as automation; 100% of 100 browsers. Contradiction fired on 3 of 1,314 real browser clients (0.2%) and on 2 of 3 scanners |
| 3 | Patterns | Built (from logs) | Numbered-path enumeration, trap links, robots.txt violations, unchanged re-fetch, asset loading | Public data: real traffic flagged 0 of 2,797 and 1 of 1,862 clients. Enumeration and trap links: tests only |
| 4 | Frequency | Built (from logs) | Peak requests per minute; machine-regular spacing at volume | Public data: 98.0% of labelled scanner requests came from flagged clients. Even spacing: tests only |
| 5 | Time window | Built | Budget windows; round-the-clock activity at volume; error ratio with rate | Public data: error ratio moved 2 of 3 scanners from unclear to slowed. Round-the-clock: tests only |
| 6 | Browser and device | Not built | Needs a script on the customer's page | - |
| 7 | Behaviour | Not built | In the separate prototype, not here | - |
| 8 | Check results | Slot | `human_check` rung, `human.liveness` signal, verification endpoint | Tests only |
| 9 | Identity linking | Partial | Groups subjects that share a supplied device, card or IP hash, and adds up their cost. Finding the link is left to the customer or a provider | Synthetic: 89.5% of farm cost caught; 80.7% farm recall without third-party signals. No real labelled data reachable |
| 10 | Usage and cost | Partial | Cost per subject and per cluster, fair-share units, key fan-out. "Same prompts from different users" and "use all then vanish" are not built | Public data (real LLM request sizes, invented identities): per-key budget caught 0-3.7% of farm cost, cluster budget 100% |
| 11 | Declared bots and agents | Partial | Recognises declared crawlers and agents; accepts a verified-identity signal. No verifier (reverse DNS, signed requests) is built | Public data: as layer 2 |

Layers 1 to 5 work from uploaded logs. **They do not yet work on live traffic**: the service scores what the
caller sends and does not compute request rates or patterns from the request stream itself.

## B. Scoring

| Item | Status | Measurement |
|---|---|---|
| One actor across identities | Built for supplied links | See layer 9 |
| A type | Built: 10 classes | 75 golden vectors, all passing |
| Risk score with confidence | Built; confidence ranks, it is not a probability | - |
| Contradictions count most | One contradiction built (browser without assets) | See layer 2 |
| Overall accuracy | - | Synthetic: precision 97.5%, abusive recall 92.3%, paying users flagged 0 of 1,085. Public data: flagged requests that were scanner requests 100% |

## C. The nine actions

| Action | Status | Note |
|---|---|---|
| Flag only | Built | `strictness: watch`; the default everywhere |
| Allow | Built | - |
| Slow down | Built | Rate budget in the Node SDK, per process |
| Limit to fair share | Built | 429 until the window resets |
| Ask for a check | Built | Ladder with a verification loop; the live check itself is a slot |
| Show a saved copy | Partial | 304 to conditional requests only; no stored or reduced copy |
| Ask to log in | Partial | A rung a company can place first (`step_up_order`); the login is the company's |
| Charge | Not built | Needs a billing decision; only a price field for metering exists |
| Block | Built | Only for strongly linked farms, or an agent denied by policy |

Built-in rules: flag first (built), block only at high confidence (built), every decision has a reason and an
appeal (built, with appeal softening and 30-day trust).

## D. Record and report

| Item | Status | Note |
|---|---|---|
| Decision log | Built | Stored per decision with reasons |
| Money report | Partial | Dollar estimate in the log audit; no monthly report from live decisions |
| Alerts | Partial | Signed webhook per flagged subject; no "attack started" alert |

## E. The eight settings

| Setting | Status | Note |
|---|---|---|
| What to protect | Partial | The caller names the surface per request; the preset's list is a label only |
| One person's fair share | Built | Amount, period, per-plan overrides, unit |
| Rules per visitor type | Partial | Per-agent rules built; no separate rule set for "unknown bot" |
| Allowed actions | Built | - |
| How strict | Built | Watch, gentle, strict |
| Which check when unsure | Built | - |
| Cost numbers | Partial | Set for the whole service by environment variable, not per company |
| Connections | Partial | Webhooks built; no adapters for Stripe, Cloudflare or others |

## F. Packs

Nine presets: the plan's six (`ai_app`, `online_store`, `scraper_blocking`, `anti_spying`, `attack_defence`,
`general`) plus `ticketing`, `publisher`, `rewards_app`. All are tested as settings. **None is tuned on real
data**, a company cannot run two at once, and `attack_defence` has no password-guessing signal.

## G. Ways to connect

| Connection | Status | Note |
|---|---|---|
| Upload logs | Built | CLI and API; the file is loaded into memory |
| Traffic hook | Partial | Node middleware only; live layers 1 to 5 are not computed (see A) |
| Page snippet | Not built | - |
| Usage feed | Built | Usage, link, signup and conversion events |

## H. Engineering

| Measure | Value |
|---|---|
| Tests | 126 (125 pass, 1 needs a database and passes on PostgreSQL 16) |
| Golden vectors | 75 |
| Decision time | 0.002 ms in process; 5.8 ms at the 99th percentile over local HTTP |
| Log audit speed | 51,462 lines in about 0.3 s |
| Store | Memory and PostgreSQL 16 pass the same contract |
| Never run | Docker image; CI on macOS, Windows, Node 24, PostgreSQL 14 and 17 |

## I. Still unproven (same list as the plan, plus two)

- That real people pass a live check easily. Not testable here.
- That buyers will pay, and at what price. No buyer has been interviewed.
- What competitors offer beyond one documentation page each (GAP-ANALYSIS.md).
- Farm detection on real labelled data: the datasets are on hosts this environment cannot reach.
- Any number on a customer's own traffic.

## What to do next, in order

1. **Stop adding features and talk to buyers.** The plan's own gate is 25 conversations and a few free log
   reports before building more. The log report works today; this is the cheapest test of whether anyone cares.
2. **Compute layers 1 to 5 on live traffic.** It is the largest gap between the plan and the product: today a
   company gets pattern detection only from uploaded logs.
3. **Bring the live-check prototype into this repository** behind the `human_check` rung, then test it on real
   people (mouse, trackpad, phone, older users, assistive tools).
4. **Get labelled farm data.** Allow the blocked dataset hosts, or use the first pilot's data.
5. **Decide on "charge".** It needs a billing choice before any code.
6. Later: prompt-overlap and use-then-vanish (layer 10), a crawler identity verifier (layer 11), a shared rate
   budget, per-company cost numbers, running two packs at once.
