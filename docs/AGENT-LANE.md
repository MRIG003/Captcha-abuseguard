# Governed agent lane

Engine paths and vectors exist (`agent-*`, `assistive-*`). Pass issuing and adapters are contract only (BACKLOG T09).

## Policy model

One `AgentPolicy` per agent id, plus `default` (`contracts/openapi.yaml`):

- `mode`: allow or deny. Deny returns a `human_path` recovery.
- `scopes`: actions the agent may take. Out of scope hands back to the person.
- `rpm`: request rate for the agent (default 60).
- `per_human_budget_usd`: see caps.
- `price_per_use_usd`, `plan`: metering hooks.

## Per-human caps

The cap belongs to the person. Cost from the person and every agent acting for them accrues to the same subject, so ten agents do not get ten allowances. Over the cap, the agent gets `limit` with `AGENT_HUMAN_CAP_EXCEEDED` and the same recovery paths as a human.

## Agent plan

A free-tier `plan: agent` is a policy row with its own `rpm` and budget: a metered allowance for agents instead of a block or the human free tier.

## Bound passes

`POST /v1/agent-passes` issues a pass that is:

- bound to one subject, one agent id and one client key;
- valid only on requests signed by that key (non-relayable);
- short-lived: 300 s default, 900 s maximum; the engine ignores credentials older than 300 s;
- stored as a hash and revocable.

## Credential adapters

An adapter verifies an external credential and emits one normalized `agent.credential` signal: `{scheme, agent_id, verified, user_bound}` with confidence and provenance. The core never parses a credential format.

Planned: Web Bot Auth, `ag-pass`, CDN-verified headers as pass-through.

## Metering hooks

On every allowed agent request the service emits a usage event (`agent_id`, subject, scope, cost attributed, `price_per_use_usd`). Billing is out of scope.

## Failure behaviour

|Situation|Result|
|-|-|
|Adapter slow or down|No credential signal; `PROVIDER_DEGRADED`; agent treated as unverified|
|Unverified or expired credential on API or signup|`inconclusive`, step-up `agent_registration`, alternative `human_path`|
|Unverified on content|allow, monitored; scraper rules still apply|
|Verified but not user-bound, off content|step-up `agent_pass_bind`|
|Engine unreachable|client fallback (DECISION-SPEC section 6)|

Declaring as an agent is never itself negative evidence.

## Assistive-tool protection

- An `assistive.tool` signal exempts the subject from step-ups, slow-downs and blocks; only the per-human cap applies.
- Keyboard-only or regular-timing interaction is not an input to any score.
- Every step-up lists a non-visual, non-gesture, non-camera alternative; `manual_review` is always available.
- Limit: the signal is self-declared. The exemption ends at scraper score 0.8 or a strongly linked farm (DECISIONS-FOR-HUMAN 5).

## Standards drift

Web Bot Auth is a draft, not an RFC.

- Each scheme lives in one adapter with its own version and test vectors.
- The core depends only on the normalized signal, so a draft revision changes one adapter.
- Adapters report the draft revision in `provenance`.
- Nothing here depends on any court ruling; policy is the site owner's own rule set.

## Not verified in this run

No adapter was built or tested against a real signed agent. Against HUMAN AgenticTrust (GAP-ANALYSIS.md source 6) we are behind on verification and at parity on policy shape.
