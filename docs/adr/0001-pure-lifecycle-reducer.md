# ADR 0001: one pure reducer decides status

Status: accepted.

**Context.** Observations arrive out of order and duplicated, and from several sources (two chains, Iris, collectors, on-demand lookups). Incremental status updates in many places drift and race.

**Decision.** `reduceLifecycle(ctx, events, now, deadlines)` is the only place status is computed. It dedupes by log identity and sorts canonically, and it is a function of the evidence set alone. The worker stores observations idempotently and re-derives status after each fetch.

**Consequences.**

- Tests are cheap and deterministic: 27 reducer cases on real fixtures, including shuffled and duplicated inputs.
- Adding evidence never regresses progress. Removing evidence (a reorg) can, deliberately.
- Every evaluation re-reads a trace's evidence, which is small per trace.
