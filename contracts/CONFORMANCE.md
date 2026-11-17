# Conformance

Every server implementation, SDK and edge adapter must pass this suite before release. The suite is the
contract; prose elsewhere is commentary.

## Requirements

| ID | Requirement | Reference test |
|----|-------------|----------------|
| C1 | Response shape matches `openapi.yaml#Verdict`: enums, `recovery` non-null unless `allow`, `effective_decision = allow` when not enforced, every reason code registered. | `assertShape` |
| C2 | Decision parity: for every vector in `golden-vectors.json`, `class`, `decision`, `reasons_include`, and where present `step`, `slow_mode`, `enforced`, `effective_decision`, `recovery_includes` match. | `C1+C2` |
| C3 | Timeout: the client enforces its own deadline (default 150 ms) and fails open to `allow` with reason `ENGINE_UNAVAILABLE`, `enforced: false`. It never throws into the caller. | `C3` |
| C4 | Fail-closed (opt-in per surface) degrades to `step_up` with `manual_review` in `alternatives`. A fallback is never `block`, `limit` or `slow`. | `C4` |
| C5 | 5xx and network errors are treated like a timeout. | `C5` |
| C6 | Signal-provider failure (`providers.<name>` not `ok`): a verdict is still returned, reasons include `PROVIDER_DEGRADED`, confidence <= 0.7, a farm `block` becomes `step_up`. | `C6` |
| C7 | 4xx are RFC 9457 problem documents with `type`, `title`, `status`; clients surface them and do not fall back. | `C7` |
| C8 | Shadow mode returns the real decision with `enforced: false`. | `C8` |
| C9 | Identifiers are HMAC-SHA256 hashed with the tenant salt before leaving the customer process (`hashId` test vector: salt `audit`, value `sk_live_abc`). | `test/logAnalyzer.test.js` |
| C10 | Store adapters pass `storeContract` in `test/store.test.js`. | memory: yes; Postgres: not yet against a live database |

## Running

```bash
npm test
```

Runs the suite against the reference engine behind `test/conformance/mockServer.js` using
`test/conformance/refClient.js`.

```bash
AG_CONFORMANCE_CLIENT=./sdk/node/dist/index.js npm test
```

Tests a JS/TS SDK. The module must export `assess(baseUrl, input, {timeoutMs, failMode, apiKey, headers})`.

```bash
AG_CONFORMANCE_URL=http://localhost:8787 npm test
```

Tests another server implementation. Fault-injection tests (C3-C5) are skipped because they need the mock's
`x-ag-test-delay` and `x-ag-test-fail` headers; a server may implement those headers in test builds to run them.

## Other languages

Python, Go, Ruby and Java SDKs port `conformance.test.js` to their native test runner and must:

1. Read `contracts/golden-vectors.json` from this repository at a pinned commit (do not copy it).
2. Start `node test/conformance/mockServer.js`-equivalent via the published Docker image (backlog T04), or point
   at a running reference server.
3. Report the spec version they passed in their package metadata.

## Change control

- Adding a vector or a reason code: minor version bump of `spec_version`.
- Changing an expected outcome of an existing vector, removing a reason code, or changing fallback behaviour:
  major bump, review required (see CONTEXT.md "do not change without review").
