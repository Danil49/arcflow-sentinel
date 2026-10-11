# ADR 0002: Postgres job table instead of Redis/BullMQ

Status: accepted.

**Context.** The worker needs retries, backoff, dead-lettering and deduplication. Adding Redis adds another stateful service to run.

**Decision.** A `jobs` table:

- Claims use `FOR UPDATE SKIP LOCKED`.
- Dedupe keys are unique only while a job is queued or running.
- Stale locks are taken over, and a former owner can't complete a job it no longer holds.
- Retries use exponential backoff with jitter, and a job is dead-lettered after N attempts.
- A "wait" result (e.g. waiting for an attestation) requeues the job without counting as a failure.

**Consequences.**

- One datastore to run.
- Outbox writes (`trace.create`, webhook deliveries) commit atomically with the state that caused them.
- Throughput is far beyond what one route needs.
