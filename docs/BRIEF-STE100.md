# abuseguard: product brief

Written in simple technical English. Version 0.4.0. Date: 2026-11-18.

## 1. Purpose

abuseguard decides who can use a web service or an API. It also decides how much each user can use.

It does four things:

1. It collects clues about each visitor.
2. It groups visitors that belong to one person.
3. It applies a rule to each visitor.
4. It gives a reason for each rule that it applies.

## 2. Problem

Some visitors are not people. Some are bots. Some are AI agents.
Some are farms. A farm is many accounts that one person controls.

These visitors cost money. They use free credits. They copy data. They buy stock before real customers. They take bonuses.

Old checks do not stop them. AI tools and bypass tools pass these checks.

abuseguard is not a better check.
It limits what one person can get. The limit applies to all accounts and keys of that person.

## 3. Terms

- **Visitor**: a person, an AI agent, or a bot that sends requests.
- **Subject**: the thing that is scored. A subject is an account, an API key, a session, a device cluster or a payment instrument.
- **Cluster**: subjects that share a device, a card or an IP address. A cluster is treated as one actor.
- **Fair share**: the amount one actor can use in one period. It can be dollars, items, tickets or pages.
- **Flag**: a record that a subject looks wrong. A flag does not change anything by itself.
- **Verdict**: the result of one decision. It has a class, a decision, reasons and a recovery path.
- **Watch mode**: the product records each decision. It does not enforce it.

## 4. Users

The main users are companies with a free plan or an expensive endpoint. Examples are:

- AI apps and AI API companies;
- online stores with limited stock;
- ticketing sites;
- publishers and listing sites with data that is copied;
- fintech and reward apps.

The user of the product is an engineer or a growth or platform lead.

## 5. How it works

The core runs the same four steps for every visitor.

**Step A. Look.** The product reads clues from the request.
It reads the path, the client type, the status, the size and the time.
It also reads usage and cost.

**Step B. Sort.** The product groups subjects into clusters. It gives each subject a class. The classes are:

- likely farm;
- legitimate heavy user;
- legitimate user;
- reseller;
- delegated agent;
- assistive tool;
- search engine;
- declared crawler;
- suspected scraper;
- inconclusive.

**Step C. Act.** The product applies the rule that the company chose.
The actions are listed from the lightest to the heaviest:

1. flag only;
2. allow;
3. slow down;
4. limit to the fair share;
5. ask for a check;
6. block.

**Step D. Show.** The product gives reasons for each decision.
It gives the dollars saved.
It sends a signed message to the company when a subject is flagged.

## 6. Rules that always apply

- A new company starts in watch mode.
- The product blocks only when the evidence is strong.
- An unclear visitor gets a check. The product never blocks an unclear visitor without a check.
- Every non-allow decision has a reason.
- Every non-allow decision has a recovery path. A person can appeal.
- A search engine is never slowed.
- A declared assistive tool is never challenged. It is still subject to the fair share.

## 7. Signals

Signal layers are groups of clues. The plan defines eleven layers. The table shows the state of each layer.

| Layer | Name | State | Test result |
|---|---|---|---|
| 1 | Network | Slot only. An outside provider must supply it | Not tested |
| 2 | Connection type | Partly built. Checks user-agent structure and asset loading | 96.9% of 2,125 crawler user-agents recognised. 100% of 100 browsers recognised |
| 3 | Patterns | Built, from logs and live | No real client flagged on two real sites |
| 4 | Frequency | Built, from logs and live | 98.0% of scanner requests came from flagged clients |
| 5 | Time window | Built | Error share moved two of three scanners to slow |
| 6 | Browser and device | Not built | Needs a script on the customer's page |
| 7 | Behaviour | Not built | Exists in a separate prototype |
| 8 | Check results | Slot only. The check itself is not built | Verification route works |
| 9 | Identity linking | Partly built. Groups links that the company supplies | 89.5% of farm cost caught on synthetic data |
| 10 | Usage and cost | Partly built | Per-key budget caught 0 to 3.7% of farm cost. Cluster budget caught 100% |
| 11 | Declared bots and agents | Partly built. No identity verifier | Not tested |

## 8. Live traffic

Layers 2 to 5 work on live traffic.

The service keeps running statistics for each subject.
The Node middleware sends each request and its outcome to the service.
The service calculates these values: rate, error share, repeat fetches, page order, timing and trap links.

Test: the public scanner logs were replayed one request at a time.

- The first flag came at request 120, 120 and 151.
- 93% to 98% of scanner requests came after the first flag.
- No client on two real sites was flagged at any time.
- The work costs about 10 microseconds for each request.

Limits:

- The statistics stay in the memory of one process.
- A restart clears them.
- A subject that is silent for one hour starts again.

## 9. Settings

A company sets these values. The company does not change code.

| Setting | Meaning |
|---|---|
| Strictness | Watch, gentle or strict. Gentle never blocks. |
| Allowed actions | The actions that the company uses. |
| Check order | The order of the checks. Manual review is always last. |
| Fair share | The amount, the period, the unit and any plan limits. |
| Agent rules | Allow or deny for each agent. The scope and the rate. |
| Robots and traps | Paths from robots.txt. Hidden trap links. |
| Endpoint costs | The dollar cost of one call to an expensive endpoint. |
| Alerts | The web address that receives signed messages. |

## 10. Presets

A preset is a set of settings for one kind of business or one job. There are nine presets:

- AI app;
- online store;
- ticketing;
- publisher;
- rewards app;
- scraper blocking;
- anti-spying;
- attack defence;
- general baseline.

All presets start in watch mode.
The numbers in the presets are starting values.
They are not tuned on real data.

## 11. Actions after a flag

| Flag | Action | How it ends |
|---|---|---|
| Over the fair share | Refuse with a retry time | The period ends, or the person adds a payment method |
| Suspected scraper | Pass 30 requests a minute. Refuse the rest. Answer repeat fetches with "not modified" | The client identifies itself or slows down |
| Unclear | Ask for one check | The company's app sends the result. The next decision uses it |
| Strong farm evidence | Block | The person appeals |
| Any flag | Send a signed message | Not applicable |

When a person appeals, the block becomes a check while the appeal is open.

If the appeal succeeds, the person is trusted for 30 days. The fair share still applies.

The product never deletes an account. It never revokes a key. It never charges money. The company does these actions.

## 12. How to connect

There are four ways to connect:

1. **Upload logs.** The company sends a log file. The product gives a cost report. Nothing is installed.
2. **Middleware.** The Node SDK sits in front of the application. It reports requests and enforces actions.
3. **Usage events.** The company sends usage and sign-up events.
4. **Page script.** Not built.

## 13. Results

Results come from synthetic data and from public data. No customer data is used.

| Test | Result |
|---|---|
| Paying users flagged, synthetic | 0 of 1,085 |
| Shared-network users asked for a check, synthetic | 2.45% |
| Farm cost caught, cluster budget, synthetic | 89.5% |
| Farm cost caught, per-key budget, synthetic | 0% |
| Precision, synthetic | 97.5% |
| Abusive recall, synthetic | 92.3% |
| Real clients flagged, two real sites | 0 of 2,797 and 0 of 1,862 |
| Real browser clients asked for a check | 1 of 1,314 |
| Decision time, in process | 0.0026 ms |
| Decision time, 99th percentile over HTTP | 6.3 ms |

These results do not prove real-world accuracy. A customer pilot must prove it.

## 14. Software

| Item | Value |
|---|---|
| Tests | 134. 133 pass. 1 needs PostgreSQL |
| Golden vectors | 75. All pass |
| Core code | 837 lines |
| Decision spec | 1.2.0 |
| Package | 0.4.0 |
| Storage | Memory, or PostgreSQL 16 |
| Runtime | Node 22 or newer. No runtime dependencies in the core |

## 15. Not built

- The live human check.
- The page script.
- Behaviour signals on the page.
- The network signal provider.
- Charging.
- Shared live state between several servers.
- Middleware for languages other than Node.
- Edge workers.
- Docker image. It is written but not run.
- Continuous integration on macOS, Windows, Node 24, and PostgreSQL 14 and 17.

## 16. Next steps

1. Talk to about 25 possible buyers. Run the free cost report for a few of them.
2. Share live state between servers.
3. Build the live human check. Test it with real people.
4. Get labelled farm data from a pilot or from an open source.
5. Decide whether to offer charging.

## 17. Run it

```bash
npm run demo
```

```bash
AG_API_KEYS=acme:a-long-random-key npm start
```

```bash
node scripts/audit.js access.log
```

Requires Node 22 or newer.

## 18. Where to read more

- `README.md`: quick start.
- `CONTEXT.md`: how to continue the build.
- `docs/SCORECARD.md`: status of every part of the plan.
- `docs/ACTIONS.md`: actions and settings.
- `docs/VALIDATION.md`: results on public data.
- `docs/DECISION-SPEC.md`: the decision rules.
