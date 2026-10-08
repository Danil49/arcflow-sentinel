# Option 1 — ArcFlow Sentinel

## Product statement

**ArcFlow Sentinel is an open-source reliability layer that follows a USDC transfer into or out of Arc through CCTP V2, converts raw chain and attestation events into one business-level state machine, flags invariant violations or stuck states, and exports a cryptographically verifiable incident/settlement receipt.**

This is not a block explorer. A block explorer displays transactions and logs; Sentinel answers operational questions:

- Is this cross-chain transfer progressing normally?
- Which stage is incomplete?
- Is it safe for the application to retry?
- Did one burn produce exactly one expected mint?
- Did the amount and recipient survive the workflow?
- What evidence can be attached to an incident, audit case, or support ticket?

CCTP V2 is the current recommended version and transfers native USDC/EURC through burn-and-mint. Arc is now a CCTP mainnet domain, making the project timely and directly connected to Circle infrastructure.[^8][^9]

## Seven-day scope

### In scope

- Arc plus **one** second EVM chain, preferably Base, Ethereum, or another route with accessible RPC infrastructure.
- Standard CCTP V2 transfer lifecycle only.
- Read-only monitoring of real public transfers.
- Manual trace lookup by source transaction hash or message hash.
- Canonical states: `SOURCE_OBSERVED`, `FINALITY_WAIT`, `ATTESTATION_PENDING`, `ATTESTED`, `DESTINATION_SUBMITTED`, `MINT_CONFIRMED`, `APPLICATION_CONFIRMED`, `FAILED_OR_STUCK`.
- Five deterministic invariants.
- Web UI, REST API, webhooks, PostgreSQL, and one small Arc-mainnet `EvidenceRegistry` contract.
- A replayable demo dataset built from actual public transactions, clearly labeled as historical.
- One live or self-funded tiny mainnet transfer if access and funding permit.

### Out of scope

- Automated recovery or transaction resubmission.
- Machine-learning anomaly detection.
- More than two chains.
- Gateway, StableFX, CPN, or generalized bridge support.
- Guaranteed incident detection.
- Custody, transaction signing for users, or insurance claims.

## Architecture

```text
Arc RPC             Source-chain RPC          Circle Iris API
   |                       |                         |
   +---------------- Event Collectors --------------+
                           |
                  Canonical Event Decoder
                           |
                 Transfer Correlation Engine
                           |
                 CCTP Lifecycle State Machine
                           |
             Invariant Rules + Stuck-State Timers
                   |                       |
              REST/Webhooks          Evidence Builder
                   |                       |
              Next.js UI       Arc EvidenceRegistry contract
                                           |
                                     receiptRoot/event
```

### Components

- **Collector worker**: polls source and Arc RPCs for relevant CCTP logs, with checkpointed block cursors.
- **Iris adapter**: queries attestation/message status where available.
- **Decoder**: converts protocol-specific logs into typed domain events.
- **Correlator**: links source transaction, CCTP message, attestation, and destination mint.
- **State machine**: computes one monotonic business status.
- **Invariant engine**: evaluates conservation, uniqueness, destination, amount, and timing rules.
- **Evidence builder**: serializes canonical JSON, computes SHA-256/Keccak hash, and signs the bundle.
- **EvidenceRegistry**: emits `EvidenceAnchored(traceId, evidenceHash, status, timestamp)` on Arc.
- **UI**: search, lifecycle timeline, raw evidence links, invariant results, and downloadable JSON.

## Data model

```text
TransferTrace
- id: UUID
- sourceChain/domain
- destinationChain/domain
- sourceTxHash
- messageHash
- sender
- recipient
- amountAtomic
- status
- statusReason
- firstSeenAt
- updatedAt

ObservedEvent
- id
- traceId
- chainId
- blockNumber
- blockHash
- txHash
- logIndex
- eventType
- rawPayload
- observedAt

AttestationObservation
- traceId
- status
- responseHash
- observedAt

InvariantResult
- traceId
- ruleId
- result: PASS | FAIL | UNKNOWN
- explanation
- evidenceRefs[]

EvidenceBundle
- traceId
- schemaVersion
- canonicalJsonHash
- signature
- arcAnchorTxHash
```

Store amounts as integer atomic units, never floating-point numbers. Keep source block hashes so the worker can detect and replay a reorganization. Enforce uniqueness on `(chainId, txHash, logIndex)` and on the CCTP message identifier.

## Invariants

1. **Unique completion**: one recognized CCTP message cannot produce two credited destination completions.
2. **Value conservation**: destination amount equals the expected amount after explicitly represented protocol fees.
3. **Recipient integrity**: decoded destination recipient matches the message recipient.
4. **Domain integrity**: source and destination domains match the expected route.
5. **Progress bound**: a trace that exceeds a configurable state deadline becomes `STUCK`, not `FAILED`, unless failure evidence exists.

## API surface

```http
POST /api/traces
{ "sourceTxHash": "0x...", "sourceChain": "base" }

GET /api/traces/{traceId}
GET /api/traces/{traceId}/events
GET /api/traces/{traceId}/invariants
POST /api/traces/{traceId}/anchor
GET /api/traces/{traceId}/evidence
GET /api/health/routes
POST /api/webhooks/test
```

The API must be idempotent. Repeating `POST /api/traces` for the same source transaction returns the existing trace. Webhooks carry an event ID, monotonic sequence, timestamp, HMAC signature, and retry count.

## Contract

Keep the mainnet contract deliberately tiny:

```solidity
contract EvidenceRegistry {
    event EvidenceAnchored(
        bytes32 indexed traceId,
        bytes32 indexed evidenceHash,
        uint8 status,
        uint64 observedAt,
        address indexed submitter
    );

    function anchor(
        bytes32 traceId,
        bytes32 evidenceHash,
        uint8 status,
        uint64 observedAt
    ) external {
        emit EvidenceAnchored(
            traceId, evidenceHash, status, observedAt, msg.sender
        );
    }
}
```

Do not store the full evidence bundle onchain. Store it offchain and anchor only its hash. The verifier recomputes the canonical JSON hash and checks the Arc event.

## Implementation stack

- **Monorepo**: pnpm + Turborepo.
- **Frontend/API**: Next.js 15, TypeScript, Tailwind, shadcn/ui.
- **Worker**: Node.js TypeScript with BullMQ, or a simple PostgreSQL job table if Redis setup would consume time.
- **Chain access**: viem; Arc mainnet is already available as a built-in chain in viem.[^4]
- **Database**: PostgreSQL via Prisma or Drizzle.
- **Contracts**: Solidity plus Arc Foundry. Arc documentation recommends Arc Foundry because standard local EVM simulation does not reproduce every Arc-specific behavior.[^5][^7]
- **Deployment**: Vercel for web/API; Railway/Fly.io/Render for persistent worker and PostgreSQL.
- **Observability**: structured JSON logs, Sentry, `/health/live`, `/health/ready`.

## Day-by-day plan

### Day 1 — Skeleton and protocol spike

- Create monorepo, CI, environment validation, PostgreSQL schema, and Next.js shell.
- Configure Arc mainnet and the chosen source chain.
- Identify CCTP V2 contracts from official documentation; do not hardcode addresses copied from blogs. Circle’s documentation explicitly advises looking up current addresses rather than hardcoding assumptions.[^10]
- Decode one known CCTP transaction end to end in a script.
- Freeze the state machine and event types.

**Exit criterion:** one command accepts a source transaction and prints decoded source, message, attestation status, and destination information.

### Day 2 — Collectors and persistence

- Implement RPC log collection and checkpointing.
- Implement Iris/status adapter.
- Store raw and normalized events.
- Add idempotent upserts, retry with exponential backoff, and dead-letter status.
- Add unit tests using captured real RPC responses.

**Exit criterion:** stopping and restarting the worker does not duplicate events or lose its cursor.

### Day 3 — Correlation and invariants

- Build the lifecycle reducer as a pure function.
- Implement the five invariants.
- Add fixture-based tests for success, pending attestation, duplicated observation, wrong recipient, missing destination, and RPC inconsistency.
- Add REST endpoints and OpenAPI output.

**Exit criterion:** at least 20 deterministic tests pass, including duplicate delivery and out-of-order events.

### Day 4 — UI and evidence

- Implement trace search, timeline, invariant panel, source links, and JSON export.
- Define canonical evidence JSON and hash procedure.
- Sign bundles with an application Ed25519 key and publish the public verification key.
- Add a standalone `verify-evidence.ts` CLI.

**Exit criterion:** a user can paste a real hash, understand the lifecycle, download evidence, and independently verify its application signature.

### Day 5 — Arc contract and mainnet deployment

- Write and test `EvidenceRegistry`.
- Deploy to Arc testnet first, then Arc mainnet with a funded deployment wallet.
- Arc mainnet uses USDC for gas, so the deployment wallet needs a small amount of mainnet USDC.[^6][^4]
- Add anchor transaction creation, status polling, and explorer link.
- Verify that the local hash equals the anchored hash.

**Exit criterion:** one evidence bundle is anchored on Arc mainnet and verifiable from the public UI.

### Day 6 — Hardening and repository

- Threat-model false positives, malicious RPC data, replayed webhooks, stale attestations, and secret leakage.
- Add rate limits, request validation, timeout budgets, and sanitized logs.
- Create architecture diagram, ADRs, local setup, `.env.example`, license, security policy, and limitations.

**Exit criterion:** a reviewer can clone the repository, run tests, start the app, and verify a published mainnet trace.

### Day 7 — Deployment and application

- Run a clean production deployment.
- Test from a new browser and mobile viewport.
- Publish contract address, Arc explorer links, sample traces, uptime endpoint, and demo video.

## Narrative

**Problem:** Cross-chain stablecoin transfers expose protocol events but leave application teams to reconstruct operational state, determine whether retries are safe, and create incident evidence.

**Solution:** ArcFlow Sentinel converts CCTP V2 events and Circle attestation states into a canonical transfer lifecycle, validates critical invariants, and anchors signed evidence receipts on Arc.

**Why Arc:** Arc is a supported CCTP destination/source and the evidence registry runs on Arc mainnet. The product directly improves the reliability and operability of USDC flows touching Arc.[^8]

**What is live:** Public trace UI, REST API, open-source indexer, invariant engine, verifier CLI, and Arc-mainnet EvidenceRegistry.

**Next milestone:** Add Gateway and Circle Wallets, route-level SLOs, webhooks, and integration SDKs.

