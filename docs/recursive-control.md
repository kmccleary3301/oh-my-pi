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

Canonical preview, shadow evaluation, promotion, and rollback must go through OMP's existing asset stores and metaharness. A model cannot self-authorize a global harness mutation.

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
