# Recursive-control benchmark plan

The evaluation unit is a score-compute frontier, not a single highest-budget endpoint.

## Arms

1. Ordinary OMP direct baseline.
2. Direct OMP plus Context Workspace.
3. Hybrid recursive control with normal tools and retained handles.
4. Strict eval-centric guidance.
5. Strict guidance plus increased child budget.
6. External Prime Agent reference where independently runnable.

## Task families

- Short localized coding tasks, to measure orchestration overhead.
- Multi-package and long-repository changes.
- Long logs, documents, transcripts, and artifact-heavy investigations.
- Long-horizon build-test-repair loops.
- OMP-specific stress tests: compaction, worktree-isolated agents, revival, background jobs, and cross-agent coordination.

## Metrics

Every run records:

- task score and pass/fail;
- root, child, and total tokens;
- root, child, and total cost;
- wall time;
- user interventions;
- child count, depth, and peak concurrency;
- context resources and characters inspected;
- tool calls and retries;
- compactions;
- quality-gate failures;
- orphaned jobs or agents;
- permission denials and crashes.

Subscription-backed costs must be labeled API-equivalent estimates rather than amounts charged.

## Promotion gate

Recursive control does not become a default because it wins one long-horizon endpoint. Promotion requires a repeatable Pareto improvement for a named model/task class, honest total-tree accounting, stable cancellation and cleanup, and no material short-task or safety regression at ordinary budgets.

Use `packages/coding-agent/scripts/compare-recursive-runs.ts` to compare normalized run summaries. The script deliberately refuses to call a high-score candidate Pareto-dominant when it spends more tokens, cost, time, or interventions.
