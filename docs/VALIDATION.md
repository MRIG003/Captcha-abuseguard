# Validation on public data

Run on 2026-11-17 with default thresholds. First run: spec 1.0.0. Re-run after adding the error-ratio signal: spec 1.1.0.
Figures below are from the re-run; where the two runs differ, both are shown.

```bash
node validation/run.js
```

The script downloads the datasets into `validation/data/` (git-ignored) and writes `validation/results.json`.
Only GitHub-hosted data was reachable from the build environment, which limits what could be tested (see the last
section).

## Summary

| Use case | Public data used | Result | How much it proves |
|---|---|---|---|
| Telling declared crawlers from browsers | 2,125 real crawler user-agents; 100 current browser user-agents | 96.9% of crawlers recognised as automation, 3.1% mistaken for a browser; 100% of browsers recognised | Solid for declared identity. Says nothing about bots that fake a browser string |
| Not flagging ordinary traffic | 51,462 real nginx requests, 2,797 clients | 0 clients flagged | Weak: one low-traffic download site from 2015, no ground truth |
| Catching aggressive automation | 17,849 labelled vulnerability-scanner requests, alone and mixed into the real traffic | 98.0% of scanner requests came from flagged clients; 100% of flagged requests were scanner requests; all three tools are now slowed | Moderate: three tools, one lab network |
| Per-human budget vs per-key budget | Real LLM request sizes (Azure, BurstGPT) with invented identities | Per-key budget caught 0-3.7% of farm cost; cluster budget caught 100% | Arithmetic only: the device links were given, not detected |
| Detecting multi-account farms | none reachable | not tested | Nothing |

## E1. User-agent classification

Sources: `monperrus/crawler-user-agents` (example strings for 1,506 crawlers), `microlinkhq/top-user-agents`,
`ai-robots-txt/ai.robots.txt`.

| Set | n | Result |
|---|---|---|
| Crawler user-agents | 2,125 | 77.6% classed as declared bot, 96.9% as some form of automation, 3.1% as browser |
| Browser user-agents | 100 | 100% classed as browser |
| AI crawler names | 208 | 68% classed as declared bot or agent; the rest as non-browser client |

**This test found a defect and it was fixed.** The first run recognised only 57.1% of crawlers as automation and
mistook 42.9% for browsers, because the classifier looked for a short word list. It now treats a user-agent as a
browser only if it has the structure of one (platform plus rendering engine), and as a declared bot if it carries
bot vocabulary or a contact URL. Browser accuracy stayed at 100%.

The AI-crawler row is a weak test: those entries are bare names, not full user-agent strings.

## E2. Real traffic: are ordinary clients left alone?

Source: `elastic/examples` nginx logs, 17 May to 4 June 2015. It is a package download server: 93% of clients are
package managers such as Debian APT.

| Group (by user-agent) | Clients | Requests | Flagged |
|---|---|---|---|
| Package managers and command-line clients | 2,594 | 50,086 | 0 |
| Listed crawlers | 126 | 649 | 0 |
| Other automation | 67 | 581 | 0 |
| Browsers | 10 | 146 | 0 |

Nothing was flagged, including clients that poll the same unchanged file repeatedly, which is what a package
manager does. That is the intended behaviour: unchanged re-fetching alone is not enough evidence.

Limits: there are no labels, request rates are low, and the site is not representative of a web application. This
is a check that the engine does not misfire on quiet legitimate automation, not a false-positive rate.

## E3. Labelled scanners

Source: `ocatak/apache-http-logs` (Baş Seyyar, Çatak and Gül, 2018): access logs produced by Acunetix, Netsparker
and w3af against a test application. Every request is abusive automation, sent with a browser-like user-agent.

| Tool | Requests | Share from flagged clients | Verdict before (1.0.0) | Verdict now (1.1.0) | Error responses |
|---|---|---|---|---|---|
| Acunetix | 6,538 | 99.9% | inconclusive, proof-of-work step-up | suspected scraper, slowed | 15.0% |
| Netsparker | 7,314 | 96.9% | inconclusive, proof-of-work step-up | suspected scraper, slowed | 35.8% |
| w3af | 3,996 | 96.7% | suspected scraper, slowed | suspected scraper, slowed | 25.2% |

Mixed into the E2 traffic (69,311 requests in total):

- Scanner requests from flagged clients: **98.0%**. Flagged requests that were scanner requests: **100%**.
- Real-traffic clients flagged: **0 of 2,797**.
- Missed: six low-volume scanner sessions (336 requests) that stayed under 120 requests a minute.

What this shows about the product:

- In the first run rate carried almost all of the detection, and two of three tools reached only the
  "inconclusive" band. Scanners produce 15-36% error responses, which the engine ignored.
- The error-ratio signal (approved and added in 1.1.0) counts a high share of error responses only when the
  request rate is also high. It moved all three tools to "slowed". Recall and precision are unchanged, and the
  real traffic in E2 is still untouched (0 of 2,797 flagged), including package managers that hit many 404s.
- The six missed low-volume sessions are still missed; they are under the rate threshold.
- A scanner is not a scraper. This validates the "aggressive automation" path, not content scraping.

## E4. Cost budgets on real LLM usage

Sources: Azure LLM inference traces 2023 (`Azure/AzurePublicDataset`) and BurstGPT (`HPMLL/BurstGPT`). They contain
real token counts per request and no user identities.

Per-request cost at an **assumed** price of $3 per million input tokens and $15 per million output tokens:

| Trace | Requests | Median | 99th percentile | Largest |
|---|---|---|---|---|
| Azure, conversation | 19,366 | $0.0068 | $0.0152 | $0.0427 |
| Azure, code | 8,819 | $0.0048 | $0.0228 | $0.0289 |
| BurstGPT, first 24 hours | 3,389 | $0.0047 | $0.0187 | $0.0338 |

Semi-synthetic farm test. The request costs are real (BurstGPT, first 24 hours, $18.30 in total). The identities
are invented: 80% of requests go to ordinary users with uneven activity, 20% go to 10 farms of 40 accounts, each
farm on one device and spreading requests evenly. Usage and device links were written to the store and decisions
were made through the engine.

| Daily budget set at | Budget | Farm accounts over their own budget | Farm cost caught, per-key budget | Farm cost caught, cluster budget | Ordinary users limited (both methods) |
|---|---|---|---|---|---|
| 90th percentile of ordinary users | $0.027 | 4 of 400 | 3.7% | 100% | 10.0% |
| 95th percentile | $0.047 | 0 of 400 | 0% | 100% | 5.1% |
| 99th percentile | $0.147 | 0 of 400 | 0% | 100% | 1.0% |

What it shows: with realistic request sizes, a farm that splits its usage stays under any per-key budget an
operator would plausibly set, and the cluster budget costs ordinary users nothing extra. What it does not show:
that the links can be found. They were supplied. The 100% is the best case.

## Not validated, and why

| Claim | What is needed | Why it was not run |
|---|---|---|
| Multi-account farm detection (precision, recall) | Labelled signups with device and payment identifiers, for example the Bank Account Fraud suite (feedzai) or IEEE-CIS | Hosted on Kaggle; not reachable from the build environment |
| Bot vs human on labelled web logs | Labelled server logs, for example the Zenodo web-robot-detection set | zenodo.org not reachable |
| Large-site scraping behaviour | The 3.3 GB e-commerce access log (Harvard Dataverse / Kaggle) | Hosts not reachable; the audit CLI also loads files into memory |
| Shared networks (campus, office, mobile) are not punished | Traffic with known NAT ground truth | No public dataset found |
| Paying users flagged under 1% | A customer's own data | Requires a pilot |
| Agent lane and assistive-tool handling | Signed-agent traffic; assistive-technology sessions | No public dataset found |

To run the blocked ones, allow `zenodo.org`, `www.kaggle.com`, `dataverse.harvard.edu` and `huggingface.co` in the
environment's network settings, or download the files and place them in `validation/data/`.

## Data sources and licences

All files are fetched at run time and are not redistributed in this repository. Check each repository's licence
before any use beyond evaluation.

- https://github.com/elastic/examples (nginx example logs)
- https://github.com/ocatak/apache-http-logs
- https://github.com/monperrus/crawler-user-agents
- https://github.com/microlinkhq/top-user-agents
- https://github.com/ai-robots-txt/ai.robots.txt
- https://github.com/Azure/AzurePublicDataset
- https://github.com/HPMLL/BurstGPT
