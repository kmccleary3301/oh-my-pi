# P31 canonical TUI E4 evidence

Date: 2026-07-21 (local; runtime envelopes use UTC)

## Provenance

- Backend repository: `/Users/kylemccleary/projects/breadboard_p31_backend_candidate_20260721`
- Backend commit: `cfbf887aeaa78acc9fb2b5e310e7cf22ff21c9ff`
- Backend tree: `c7e7c6a13038cb5c1a89e12cfaa152790689c48b`
- TUI repository: `/Users/kylemccleary/projects/breadboard_p31_bb_omp_candidate_20260721`
- SDK package: `@breadboard/sdk@0.2.2`
- SDK tarball SHA-256: `4a2a12826e655908db9ee46a2c0d2d86c502a422646e127160dd963d4fd1da55`
- Engine mode: `local-external`
- Backend config: `agent_configs/misc/opencode_cli_mock_guardrails.yaml`

The live run used the deterministic mock provider. The mock credential was supplied through `MOCK_API_KEY`; no credential value appears in this record.

## Failing sequence and correction

The first governed TUI attempt exposed three contract defects in order:

1. A tool-only `assistant_message` was projected as an empty assistant completion.
2. A turn-owned todo snapshot arrived as `tool_result` and was decoded as a normal tool result. It consumed the only pending tool-call correlation.
3. The mock provider emitted a public tool name in `tool_call`, an implementation name in `tool_result`, and a duplicate role-tool message. The result had no provider call ID.

The minimum correlation sequence was:

```text
tool_call  call_id=e4-tool:1:1  tool=todo.write_board
tool_result payload.todo=...   turn-owned snapshot
tool_result call_id=<missing>   tool=todo.write_board
```

The corrected contract now:

- classifies tool-only assistant messages as `assistant_message_started`;
- projects any `tool_result` carrying `payload.todo` as `todo_updated` without consuming a pending call;
- synthesizes a call ID when the provider omits one;
- correlates a result to the sole pending call when public and implementation tool names differ;
- drops the duplicate role-tool result after the canonical result is recorded;
- keeps unsupported event families fail-closed and redacted.

## Live result

Successful backend session: `38bf14ee-b9c7-4147-8db1-8cacdeaab7b2`

Terminal turn:

```text
input_id=input-5b240663-88ef-4e30-95bd-08fe42e1d00e
turn_id=turn-e6c5c92b-b448-4948-9960-09153dc9771d
outcome=completed
terminal_event=turn_completed
terminal_sequence=86
```

The native OMP transcript rendered the todo tool, `write`, `run_shell`, redacted failures, `TASK COMPLETE`, and the final `Completed` status. The session projector remained unfrozen and accepted the terminal event.

## Checks

```text
uv run --isolated --with-requirements requirements.txt --with pytest \
  python -m pytest -q \
  tests/test_cli_bridge_task_event_normalization.py \
  tests/test_cli_bridge_contract_exports.py
result: 9 passed

npm run build && node --test \
  test/session-runtime.test.mjs \
  test/session-evidence.test.mjs
result: 39 passed

bun test \
  ./src/breadboard/session-event-projector.test.ts \
  ./src/modes/breadboard-interactive-session-mode.test.ts
result: 31 passed

bun run check:types
result: passed

bun run gate:breadboard-sdk
result: passed; 18 installed files verified
```

The projector test covers correlated tool calls/results, permission request/response, artifact references, todo updates, and subagent task events in the native transcript. The live mock run covers tool calls/results, todo updates, assistant completion, and the terminal turn.
