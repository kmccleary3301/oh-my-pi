# P31 canonical TUI E4 evidence

Date: 2026-07-22 (local; runtime envelopes use UTC)

## Provenance

- Backend repository: `/Users/kylemccleary/projects/breadboard_p31_backend_candidate_20260721`
- Backend commit: `36d92d9cf62d2930337ceef61be25a539752821f`
- Backend tree: `3f480970a361c47fb2273b3873ab02741da73c6a`
- Canonical SDK implementation commit: `7f47f239316a90bc377941f6dd48995b56bea6a4`
- P30 client manifest commit: `802ecd539d42223384439f228e71cf30432fe117`
- TUI repository: `/Users/kylemccleary/projects/breadboard_p31_bb_omp_candidate_20260721`
- TUI implementation commit: `5480956516a4b4a8027edc2ad33ee9fb883b8611`
- SDK package: `@breadboard/sdk@0.2.2`
- SDK tarball SHA-256: `d9a9bc4ead5991ae23416f6da6a3849dbcdcf4c4e21f508d65ba798e295f02ff`
- Engine mode: `local-external`
- Backend config: `agent_configs/templates/minimal_harness.v2.yaml`

The live run used the deterministic reference provider. No credential, request header, response body, raw provider payload, or private account value is recorded here.

## Defects found by the live path

The governed TUI runs exposed these boundary defects:

1. Tool-only `assistant_message` envelopes were projected as empty assistant completions.
2. Todo snapshots carried by `tool_result` consumed the only pending tool-call correlation.
3. Public and implementation tool names differed while provider call IDs were absent.
4. The runtime emitted repeated role-tool and direct tool results after the canonical result.
5. Audit-only `lifecycle_event` envelopes were promoted to unsupported-family failures even though their ctree projection already carried the lifecycle evidence.
6. `stop` emitted an unrelated task event, and debug permission events could be emitted without an active correlated turn.
7. Permission responses did not prove that their exact request ID was still pending at delivery time.
8. Terminal turns could retain unresolved tool, permission, or task children, and turn-owned event families were not uniformly rejected outside an active correlated turn.
9. Projector state retained shallow copies of runtime-controlled payloads that were safe only because the renderer sanitized them later.
10. BreadBoard engine flags could reach native print/RPC/ACP startup paths even though those paths have no canonical BreadBoard transport.

The corrected path now:

- classifies tool-only assistant messages as `assistant_message_started`;
- decodes todo snapshots as `todo_updated` without changing tool correlation;
- synthesizes stable per-turn tool-call IDs and clears correlation when each admitted turn starts;
- correlates the sole pending result across public/implementation aliases;
- suppresses repeated results only after the canonical result is recorded, while explicit mismatched call IDs still fail;
- consumes top-level `output` as a tool result when `result` and `content` are absent;
- treats `lifecycle_event` as duplicate orchestration telemetry because canonical admission, tool, ctree, completion, and terminal envelopes already represent it;
- emits a redacted `unsupported_runtime_event_family` error for genuinely unknown runtime families;
- routes permission decisions through the canonical session command and requires active turn correlation;
- renders todo state and permission prompts through native OMP components;
- redacts runtime-controlled text before it reaches native tool, permission, task, and status components.
- consumes each exact pending permission only after the backend accepts and publishes the response;
- rejects turn-owned tool, permission, todo, task, and completion events without the active correlated turn;
- rejects terminal events while tool, permission, or task children remain unresolved;
- stores deep projected, sensitive-value-redacted payloads and strips terminal control sequences before rendering;
- coalesces todo snapshots into one native todo row and maps subagent progress/results into OMP's native task component;
- preserves native OMP print/RPC/RPC-UI/ACP behavior with engine mode off and fails unsupported BreadBoard engine selections before those transports start;
- renews lifecycle ownership through idempotent ambiguous-replay handling, preserving one absolute expiry deadline and exact-once drain rollback.

## Live result

Successful backend session: `8b7e4572-b5a6-490b-9d57-6f60ae75213a`

Terminal turn:

```text
input_id=input-344ba7f1-bbfb-4d98-8783-6a55ca2b3361
turn_id=turn-a3c89912-48b8-4052-8d0c-3f56ea7cb587
outcome=completed
terminal_event=turn_completed
terminal_sequence=76
```

Canonical tool correlation:

```text
tool_call    call_id=e4-tool:1:1  tool=list_dir
tool_result  call_id=e4-tool:1:1  tool=list_dir
tool_call    call_id=e4-tool:7:2  tool=apply_unified_patch
tool_result  call_id=e4-tool:7:2  tool=apply_unified_patch
```

The replay stream contained zero `error` envelopes. The native transcript rendered both tools, their results, the final assistant message, and `Completed`. The client remained open for another turn after accepting the terminal event. This live turn did not emit a todo snapshot; the native todo path is covered by the focused projector and mode tests below.

## Final post-hardening smoke

The final code and backend commits above completed a second live native-OMP turn through `local-external` mode:

```text
session_id=e31434f4-6273-48e6-ba45-99ad2e47a90b
engine_identity=200
client_registration=200
session_create=200
input_admission=202
terminal_status=Completed
```

The visible native transcript rendered `list_dir`, `apply_unified_patch`, their redacted arguments/results, the assistant continuation, and `Completed`. The backend repository remained clean after the run. The deterministic reference provider selected its canned tool sequence rather than the requested read-only sequence; this smoke therefore proves final transport/projector/native-transcript completion, not prompt adherence.

## Checks

```text
uv run --isolated --with-requirements requirements.txt --with pytest \
  python -m pytest -q \
  tests/test_cli_bridge_task_event_normalization.py \
  tests/test_cli_bridge_session_nav_commands.py
result: 15 passed

npm run build && node --test \
  test/session-runtime.test.mjs \
  test/session-evidence.test.mjs
result: 40 passed

node --test test/p30-bb89n14-gate.test.mjs
result: 90 passed

bun test --parallel=1 \
  src/breadboard/session-event-projector.test.ts \
  src/breadboard/canonical-e4-session-port.test.ts \
  src/modes/breadboard-interactive-session-mode.test.ts \
  src/breadboard/lifecycle/lifecycle-supervisor.test.ts \
  test/breadboard-sdk-provenance.test.ts
result: 152 passed

bun test --parallel=1 test/breadboard-lifecycle-real-backend.integration.test.ts
result: passed ten consecutive runs; 40 assertions per run; 182.82s–183.55s per run; 1,830.70s total

bun test --parallel=1 \
  test/silent-abort-print-mode.test.ts \
  test/print-mode-working-indicator.test.ts \
  test/cli-print-thoughts-flag.test.ts \
  test/rpc.test.ts \
  test/rpc-client.start.test.ts \
  test/rpc-frame.test.ts \
  test/rpc-input-frame.test.ts \
  test/acp-lazy-startup.test.ts \
  test/acp-client.restart.test.ts \
  test/acp-transport-runtime-mode.test.ts \
  test/acp-command.test.ts \
  test/acp-agent.test.ts \
  test/acp-client-bridge.test.ts \
  test/acp-event-mapper.test.ts \
  test/acp-initialize-conformance.test.ts
result: 607 passed

bun run check:types
result: passed

bun run gate:breadboard-sdk
result: passed; artifact d9a9bc4e..., backend 36d92d9c..., tree 3f480970..., 18 installed files verified
```

Focused TUI coverage includes correlated tool calls/results, artifact references, native todo and subagent-task rendering, exact permission selection, cancellation, unsupported-family failure, deep projector-state redaction, terminal-control stripping, terminal child invariants, protocol-mode startup parity, and repeatable real-backend lifecycle recovery. The two live runs add proof that the real backend, installed SDK tarball, projector, and native OMP transcript complete correlated E4 turns end to end.
