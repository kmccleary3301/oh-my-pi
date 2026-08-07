# Recursive control

OMP's recursive-control surface makes large context, retained agents, exact control state, and measured harness improvements programmable from the existing persistent eval runtimes.

It is a semantic port of selected Prime Agent `0.7.0` ideas into OMP's own harness. OMP remains the only owner of model transport, credentials, sessions, tools, approvals, subagents, worktrees, persistence, and UI. Prime Agent is not launched underneath OMP.

## Enable it

The feature is disabled by default:

```json
{
  "recursive": {
    "enabled": true
  }
}
```

When enabled, every eval backend exposes `omp`:

```text
omp.context       bounded conversation, agent, and resource access
omp.tools         host-owned OMP tool calls
omp.agents        retained OMP task-agent handles
omp.state         JSON-only session/project control state
omp.budget        root-plus-descendant usage and admission state
omp.improvements  auditable proposals and measured outcomes
```

When disabled, the namespace remains syntactically available so persistent kernels do not need to restart, but every call fails closed with a clear feature-gate error.

## Work modes

`recursive.mode` selects how much of the ordinary tool slate the root keeps:

| Mode | Root slate | Use |
|---|---|---|
| `hybrid` (default) | ordinary OMP tools **plus** `omp.*` | normal use |
| `strict` | eval-centric slate only (`recursive.strictTools`, always including `eval`) | experiment |

Strict mode forces every action through the control plane. Prime's own research reports
mixed outcomes for eval-only roots, so it is explicit, model-aware, and reversible:

```
/recursive mode strict
/recursive mode hybrid
```

`recursive.strictModels` gates which models may run strict, and it **ships empty on
purpose** — no model has been benchmarked on an eval-only slate here, so claiming a
capability list would be unfounded. Add a model id, or set `recursive.strictAllowAnyModel`
to experiment. A refused strict request degrades to hybrid with a stated reason rather than
failing the session.

Entering strict captures the current slate and leaving restores exactly that slate, so the
mode cannot silently discard a user's tool configuration. `/recursive off` also restores it.

## Context as data

Use `omp.context.list()` or `omp.context.search()` to obtain bounded references. Read only the slices needed for the current decision:

```python
hits = omp.context.search("authentication failure", scope=["conversation", "agents"])
page = omp.context.read(hits["items"][0]["ref"], limit=4000)
```

References are fingerprinted. A list/search item fingerprint identifies that descriptor; a read result fingerprint identifies the resolved content. Pass the fingerprint from a previous read as `expectedFingerprint` on a later read to reject stale mutable resources. Large selected sets can be materialized as an `artifact://` resource rather than injected into the active model context.

## Retained agents

`omp.agents.spawn()` starts an ordinary OMP task agent and keeps its OMP session retained after the turn settles:

```python
reviewer = omp.agents.spawn(
    "Review the authentication subsystem and yield structured findings.",
    agent="reviewer",
)
reviewer.send("Prioritize authorization boundaries.", delivery="when-idle")
observation = reviewer.observe(max_chars=4000)
reviewer.wait(until="terminal")
reviewer.release()
```

The handle is a projection over OMP's existing Task runtime, Agent Registry, lifecycle revival, Hub messaging, and `agent://` output. It is not a second agent system. Handles are session-owned and released on session change or disposal.

The implementation returns a stable admission handle as soon as OMP reserves the child agent ID. The child's first turn continues in the background, and the caller can immediately inspect, message, wait for, cancel, or release the retained agent.

## Durable resident sessions

Retained handles live in the spawning process. `omp.resident` persists the identity,
ownership lease, and wake schedule of a retained agent alongside the rest of the project's
recursive-control state, so a later process can find an agent it did not spawn.

It owns records and leases, not processes; reviving execution stays with the existing agent
lifecycle manager.

```js
await omp.resident.register({ handle, agentId, sessionId, label: "indexer", leaseMs: 60_000 });
await omp.resident.detach(handle);            // give up ownership, keep the agent
await omp.resident.attach(handle);            // pick it up from another process
await omp.resident.detach(handle, { passivate: true });  // deliberately unload
await omp.resident.schedule(handle, { wakeAt, everyMs });
await omp.resident.claimDue();                // records whose wake time arrived
```

A record is in exactly one state:

| State | Meaning |
|---|---|
| `active` | an owner holds a live lease |
| `detached` | released cleanly; free to attach |
| `passivated` | deliberately unloaded to free resources; free to attach |
| `expired` | the owner's lease lapsed without renewal; free to attach |

`expired` is kept distinct from `detached` on purpose: it is the signal that the previous
owner did not shut down cleanly, which is exactly what a recovering process needs to know.

Only the lease holder may renew, detach, or reschedule, and `attach` is refused while another
owner's lease is still live — two processes driving one agent would interleave turns on a
single transcript. Repeating schedules roll forward as they are claimed, so one due check
cannot fire the same wake twice.

## Exact control state

`omp.state` stores bounded JSON values outside the active context:

```python
record = omp.state.put("remaining-files", ["a.ts", "b.ts"])
omp.state.put(
    "remaining-files",
    ["b.ts"],
    expected_fingerprint=record["fingerprint"],
)
```

Session and project scopes are supported. Writes are private, atomic, and conflict-checkable. Arbitrary pickle, `dill`, executable object graphs, credentials, and transcript copies are intentionally unsupported.

## Recursive accounting

`omp.budget.status()` reports root and descendant usage together. Configured token, cost, wall-time, and handle limits are host-owned and checked before new retained-agent admission.

The same tree is available without enabling recursive control. `/session` prints an **Agent Tree** section whenever the current session has descendants, showing own, descendant, and total tokens plus each agent's status and model. Session statistics alone fold in direct task results but never a grandchild's spend, so root-only counts understate any recursive run; the tree is reconstructed from Agent Registry lineage and is the only complete rollup.

Cost carries a deliberate caveat: for subscription-backed providers the reported figure is a catalog-equivalent estimate, not an amount billed, and `premiumRequests` is the separate subscription meter. Neither is presented as money charged.

## Improvement Ledger

The model can propose improvements to memory, skills, agent definitions, rules, or supplemental policy. The ledger records evidence, base fingerprints, validation plans, revisions, and measured outcomes. It does not apply changes.

Canonical apply and rollback still go through OMP's existing asset stores. A model cannot self-authorize a global harness mutation.

### Preview

`omp.improvements.preview(id, currentBaseFingerprint)` is a read: it returns the proposal, its
outcomes, whether the base moved since the proposal was written, and the list of blockers still
standing between it and promotion. Omitting the fingerprint does not assume freshness — it is
reported as its own blocker.

### Shadow evaluation

`omp.improvements.evaluateShadow({ baseline, candidate, holdoutRunIds })` derives a
recommendation from measured runs instead of accepting an asserted one. Success rate is the
primary metric; cost, wall time, tokens, and interventions can block a promotion but never buy
one. The verdict is conservative by construction:

- fewer than three runs per arm, or no success signal → `collect-more-data`
- success rate fell → `reject`
- success unchanged, with a secondary regression → `reject`
- holdout runs declared but no candidate covered them → `collect-more-data`
- success unchanged and nothing regressed → `collect-more-data`, because harmless is not an improvement
- success rose → `promote`, with any secondary regressions recorded on the outcome

### Measured promotion

Reaching `applied-project` or `promoted` requires all of:

- a recorded outcome recommending `promote`
- `project` or `user` scope; a session-scoped proposal cannot silently widen
- a reviewer different from the proposal's author, so the ledger is not a rubber stamp
- a rollback artifact with a URI and a fingerprint

The reviewer and rollback are stored on the proposal as `promotion`, alongside the timestamp.

## Quality gates

The reusable `QualityGateRunner` executes host-owned verifiers and records evidence. If a required gate already failed and the workspace fingerprint has not changed, the next attempt is skipped rather than paying to rerun the same check.

The runner is wired into goal completion. Configure `goal.gates` with verifier commands and
a goal cannot be marked complete until every required gate exits `0`:

```jsonc
"goal.gates": [
  { "id": "tests", "label": "Unit tests", "command": "bun test", "timeoutMs": 600000 },
  { "id": "lint", "command": "bun run check", "required": false }
]
```

Gates default to `required: true`. When a required gate does not pass, `goal complete` is
rejected with the failing gate's output and the goal stays active, so the agent keeps
working instead of declaring victory. A gate that already failed on an unchanged workspace
is reported as `skipped` — that suppresses redundant compute but is still not a pass.

The workspace fingerprint covers `HEAD`, porcelain status, and the tracked diff. Content
edits to untracked files are not captured, and outside a git worktree suppression is
disabled entirely rather than risking a goal that can never complete.

## Safety and ownership

- No nested Prime Agent process or runtime.
- No new provider, auth, MCP, or permission layer.
- Tool calls use the current OMP tool registry.
- Retained agents use OMP task execution and lifecycle state.
- Large text remains behind canonical references and artifacts.
- Persistent control state is JSON-only and size-bounded.
- Improvement proposals cannot directly mutate canonical assets.
- Recursive mode changes no defaults while disabled.

The exact Prime snapshot file hashes and semantic dispositions are recorded in [`docs/prime-agent-semantic-port.md`](./prime-agent-semantic-port.md).
