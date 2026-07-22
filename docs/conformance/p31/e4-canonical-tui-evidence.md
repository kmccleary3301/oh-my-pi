# P31 canonical TUI E4 evidence

Date: 2026-07-22 (local; runtime envelopes use UTC)

## Provenance

- Backend repository: `/Users/kylemccleary/projects/breadboard_p31_backend_candidate_20260721`
- Backend commit: `b1e86f0636712d13d084bff9f171e8dd87bf19e0`
- Backend tree: `9e963158ad29135e160a572752a769b3e37bf102`
- Canonical SDK implementation commit: `7f47f239316a90bc377941f6dd48995b56bea6a4`
- P30 client manifest commit: `802ecd539d42223384439f228e71cf30432fe117`
- TUI repository: `/Users/kylemccleary/projects/breadboard_p31_bb_omp_candidate_20260721`
- TUI implementation commit: `a69241984cc2e7c571e7f38f39c00627b02d6944`
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

## Checks

```text
uv run --isolated --with-requirements requirements.txt --with pytest \
  python -m pytest -q tests/test_cli_bridge_task_event_normalization.py
result: 11 passed

npm run build && node --test \
  test/session-runtime.test.mjs \
  test/session-evidence.test.mjs
result: 40 passed

node --test test/p30-bb89n14-gate.test.mjs
result: 90 passed

bun test \
  ./src/breadboard/session-event-projector.test.ts \
  ./src/modes/breadboard-interactive-session-mode.test.ts \
  ./src/breadboard/canonical-e4-session-port.test.ts \
  ./test/breadboard-sdk-provenance.test.ts
result: 61 passed

bun run check:types
result: passed

bun run gate:breadboard-sdk
result: passed; artifact d9a9bc4e..., backend b1e86f063..., 18 installed files verified
```

Focused TUI coverage includes correlated tool calls/results, artifact references, native todo rendering, live permission selection, cancellation, subagent task events, unsupported-family failure, and runtime-text redaction. The live run adds proof that the real backend, installed SDK tarball, projector, and native OMP transcript complete one correlated E4 turn end to end.
