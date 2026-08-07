# Prime Agent semantic-port map

This document records how the attached Prime Agent `0.7.0` architecture is interpreted in OMP. It is a **semantic port**, not a code transplant. OMP remains the only harness and state authority; Prime Agent is not launched underneath OMP.

## Source identity

| Field | Value |
|---|---|
| Package version | `0.7.0` |
| License | MIT |
| Archive SHA-256 | `fe29238eda8fdbdb5fbdbacca5ee762e3f76ef4cebca143c71d41f6aae16a910` |
| Revision | `archive-without-git-metadata` |

The attached ZIP did not contain Git metadata, so no source commit is claimed. File hashes below identify the load-bearing Prime sources that informed the port.

## Mapping

| Prime concept | Prime source | OMP destination | Decision |
|---|---|---|---|
| Context as a variable | `docs/rlm.md`, `docs/rlm-runtime.md` | `recursive-control/context-workspace.ts` | Take with OMP resource ownership and strict bounds |
| IPython as sole root tool | `core/tools/ipython.ts` | Existing multi-language `eval` plus `omp.*` | Take as opt-in guidance; do not replace OMP tools by default |
| Python host API | `prime-agent-runtime/src/rlm/__init__.py` | Eval host bridge and language projections | Rewrite; no credentials or provider authority in kernels |
| Recursive child calls | RLM runtime | Retained handles over structured subagents and Agent Registry | Take with explicit delivery and lifecycle semantics |
| Executable skills | Prime skill runtime | Native OMP tool/skill proxies | Take ergonomics, retain OMP canonical skill system |
| Recursive usage | RLM runtime | `RecursiveBudgetLedger` | Take and count every descendant |
| Persistent harness state | `rlm/harness.py` | Explicit JSON state plus canonical OMP assets | Split; do not create a second harness-state owner |
| Prompt/memory/skill/subagent refinement | `core/refinement/refinement.ts` | Governed Improvement Ledger | Take with independent evaluation and promotion |
| Quality-gated autonomy | `core/autonomous.ts` | `QualityGateRunner`, future goal/loop adapter | Take; cache failed gate against workspace fingerprint |
| Agent messages and observation | `core/agent-messages.ts`, `agent-observe.ts` | Existing session messaging, Hub, Agent Registry | Expose through handles; no new bus |
| Kernel `dill` snapshots | `kernel/state-snapshot.ts` | Explicit JSON/artifact state | Reject automatic arbitrary object deserialization |
| Daemon/supervisor | `docs/daemon.md` | Separate future durable-session campaign | Mine invariants only; do not nest or transplant |
| Schedules and heartbeats | `core/cron-jobs.ts` | Future session-action store | Defer until resident root sessions exist |
| Prime wire protocol | daemon/client protocol | OMP RPC/ACP | Reject; OMP keeps its own protocol |

## Load-bearing source hashes

| Path | SHA-256 | Disposition |
|---|---|---|
| `packages/coding-agent/docs/rlm.md` | `7e88409a3f3ce0ef6b8f470ab7bc63906e4301930b63f52f5c127997819b1fce` | semantic-port: context-as-data and model-facing control surface |
| `packages/coding-agent/docs/rlm-runtime.md` | `b1c81e49a1e44bcfe474754067b08980d05676daef7a58119f59ad0f7d36c46d` | semantic-port: host callback and retained child lifecycle invariants |
| `packages/coding-agent/src/core/tools/ipython.ts` | `157f8f977a6951054084ba8677cfd1a61484d62ebf50eb9a5e2250ebde5af0b4` | reference-only: OMP keeps its multi-language eval implementation |
| `packages/coding-agent/src/core/rlm-runtime.ts` | `c7574d8e54c6f868026b44da48abf609aba20d3e084341f3a8df4d58b4946004` | semantic-port: bounded host operations; no nested Prime runtime |
| `prime-agent-runtime/src/rlm/__init__.py` | `9f9d76ff50fd403652597e63d6de2c35826bdde63ef0137e00048b008a046331` | semantic-port: language facade only; host remains authoritative |
| `prime-agent-runtime/src/rlm/harness.py` | `3dd7d1e8c11805a24581f40392141df16b370406161c5135192c0ac62bd6062a` | redesigned: proposal-only Improvement Ledger over canonical OMP assets |
| `packages/coding-agent/src/core/refinement/refinement.ts` | `3f94b16e4626a42dfd22254d8c1426223045d29eabb2be14ec292593a4a9512c` | redesigned: measured outcomes and explicit promotion; no automatic mutation |
| `packages/coding-agent/src/core/autonomous.ts` | `bb3c243c274519c2907af7bb0c15b3640a4a77a6113df36da71d2dc3a09143c6` | semantic-port: evidence gates and unchanged-workspace suppression |
| `packages/coding-agent/src/core/agent-messages.ts` | `d2f42536f732deaf14d2cea77cece870ae0edcda86c824ced0d1387ac0ee6f05` | reference-only: OMP reuses Hub and explicit delivery semantics |
| `packages/coding-agent/src/core/agent-observe.ts` | `b1e5b8bead3e51f2d9e6819a9cb75fc50de95d20fa726aae187c7dd78148a543` | semantic-port: bounded observations backed by agent:// and history:// |
| `packages/coding-agent/src/core/kernel/state-snapshot.ts` | `046936cf9d11e565e9594ad0ca0b953951dc66de3a795648c56d4de56a7e2320` | rejected: arbitrary object snapshots; OMP uses explicit JSON state |
| `packages/coding-agent/docs/daemon.md` | `90d1d1d328ae9d1e6f44bd12a3068b4737540c3f4830831b6954bfa339d6c1f2` | future campaign: extract leases/recovery invariants, not daemon code |

## Port rules

1. OMP remains the only harness and state authority.
2. Reuse existing tools, task runtime, Agent Registry, lifecycle, Hub, artifacts, settings, and persistence.
3. Treat Prime benchmark claims as hypotheses until reproduced with total child-plus-root compute accounting.
4. Keep every new behavior disabled by default.
5. Promote generic OMP primitives only after at least one native use proves the need.
6. Review upstream Prime changes semantically rather than mechanically copying files; update the hash table above when a new snapshot informs the port.
