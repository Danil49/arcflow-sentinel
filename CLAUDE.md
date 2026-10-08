# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

Phase 1 (skeleton and protocol spike) of the plan in `idea.md` is done. The Next.js app, DB, contract, and evidence packages don't exist yet. Other reference files:

- `idea.md`: the product spec and source of truth. It defines scope, architecture, data model, invariants, API, contract, and a 7-day plan.
- `docs-references.md`: an index (llms.txt style) of Arc docs. Use it to find the right Arc page to fetch.
- `fixtures/`: real captured mainnet RPC receipts and Iris responses, labeled historical. Tests load them directly.

## Commands

pnpm isn't installed globally here, so run it as `npx pnpm@10.18.3 …` (the version is pinned in `packageManager`).

- `pnpm install`
- `pnpm test`, `pnpm typecheck`: all packages via Turborepo
- `pnpm lint`, `pnpm format`, `pnpm format:check`
- One package: `pnpm --filter @sentinel/core test`
- One test: `pnpm --filter @sentinel/core exec vitest run test/message.test.ts -t "rejects truncated"`
- Live spike: `pnpm --filter @sentinel/worker trace-once <sourceTxHash> --from base|arc [--save fixtures/<name>]`. This hits public RPCs and Iris. Settings come from an optional root `.env` (see `.env.example`).

## Code layout

- `packages/core`: pure domain logic with no I/O.
  - CCTP V2 ABIs
  - The message header/body decoder
  - `decodeCctpLogs` (only trusts logs from the configured CCTP contract addresses)
  - The Iris response parser
  - Domain event types and the lifecycle state enum
- `packages/chains`: per-network route config (Arc and Base addresses, domains, USDC, log chunk sizes, with source-doc comments), viem clients, `findBlockAtOrAfter`, and `getLogsChunked`.
- `packages/config`: zod env parsing. Errors name the variables but never echo their values.
- `apps/worker`: the Iris client and `traceOnce`. These are I/O shells over core, with deps injected so they can be tested with fakes.

Packages export their TypeScript sources directly (`exports: ./src/index.ts`) with no build step. Relative imports use `.js` extensions (NodeNext).

## CCTP V2 facts verified against mainnet (don't "fix" these from the docs)

- The event table in Circle's contract-interfaces docs doesn't match the deployed V2 contracts.
  - The real signatures are in `packages/core/src/abi.ts`.
  - `test/abi.test.ts` checks them against the topic0 hashes of real logs.
  - `MessageReceived` indexes `caller`, `nonce` (bytes32) and `finalityThresholdExecuted`. `sourceDomain` is in the data, not a topic.
- In the source-chain `MessageSent` log, `nonce`, `finalityThresholdExecuted`, `feeExecuted` and `expirationBlock` are **zeroed**, because Circle assigns them at attestation time. Linking a source tx to its destination therefore goes source tx → Iris `eventNonce` → destination `MessageReceived` filtered by nonce.
- `MintAndWithdraw` is emitted by TokenMessengerV2 on the destination chain and includes `feeCollected`.
- Within a network, the CCTP V2 contract addresses are the same on Arc and Base. Arc is domain 26 and Base is domain 6.
- Iris returns `"PENDING"` and `"0x"` placeholders before attestation. `parseIrisMessages` maps them to null. Iris returns HTTP 404 when it hasn't indexed a transaction yet.
- Public RPC limits:
  - Base `mainnet.base.org` caps `eth_getLogs` at a 500-block range.
  - `rpc.mainnet.arc.io` rate-limits bursts (`-32005`).

## Planned architecture (from idea.md)

ArcFlow Sentinel is a read-only reliability monitor for CCTP V2 USDC transfers between Arc and **one** other EVM chain. It is not a block explorer. Data flows in this order:

Arc RPC + source-chain RPC + Circle Iris API → collectors (checkpointed block cursors) → decoder (typed domain events) → correlator (links source tx ↔ CCTP message ↔ attestation ↔ destination mint) → lifecycle state machine → invariant engine + stuck-state timers → REST/webhooks and evidence builder → `EvidenceRegistry` on Arc mainnet.

Design rules the spec requires:

- **States:** `SOURCE_OBSERVED`, `FINALITY_WAIT`, `ATTESTATION_PENDING`, `ATTESTED`, `DESTINATION_SUBMITTED`, `MINT_CONFIRMED`, `APPLICATION_CONFIRMED`, `FAILED_OR_STUCK`. The reducer is a pure, monotonic function and must tolerate duplicate and out-of-order events.
- **Five invariants:** unique completion, value conservation (after explicit fees), recipient integrity, domain integrity, and a progress bound. When the progress bound is exceeded the trace becomes `STUCK`, not `FAILED`, unless there is failure evidence.
- **Storage:** keep amounts as integer atomic units, never floats. Keep source block hashes so reorgs can be replayed. Enforce uniqueness on `(chainId, txHash, logIndex)` and on the CCTP message id.
- **API:** must be idempotent (`POST /api/traces` with the same source tx returns the existing trace). Webhooks carry an event ID, monotonic sequence, HMAC, and retry count.
- **Evidence:** canonical JSON → SHA-256/Keccak hash → Ed25519 signature. Only the hash is anchored on chain, via a deliberately tiny emit-only `EvidenceRegistry` contract. A standalone `verify-evidence.ts` CLI recomputes the hash and checks it.
- **Addresses:** look up CCTP V2 contract addresses in the official docs. Never copy them from blogs.
- **Out of scope:** automated recovery or resubmission, ML, more than two chains, Gateway/StableFX/CPN, and custody or signing for users.

Stack decisions:

- The route is Arc ↔ Base.
- Next.js 15 (TypeScript, Tailwind, shadcn/ui) serves the UI and API.
- The worker uses a Postgres job table (`FOR UPDATE SKIP LOCKED`), not BullMQ/Redis.
- Database access goes through Drizzle.
- Chain access is viem, which has Arc built in.
- Contracts use Solidity with Arc Foundry.

The phase-by-phase plan is in `~/.claude/plans/frolicking-stargazing-snowflake.md`.

## Tooling and permissions

`.claude/settings.json` allowlists pnpm, turbo and arc-forge commands. Editing `pnpm-lock.yaml` and `.env` is denied: change dependencies through pnpm. `git push`, `--no-verify` commits, and hard resets are denied.

## Arc domain notes (from docs-references.md)

The project targets Arc, Circle's L1 chain. Use the `circle:use-arc` skill and other `circle:*` skills for Arc/USDC work. Arc behaves differently from Ethereum in ways that cause bugs:

- USDC is the native gas token and uses **18 decimals natively**. The ERC-20 USDC interface uses 6 decimals.
- All native USDC Transfer events are emitted by the system address `0xffffFFFfFFffffffffffffffFfFFFfffFFfFFfFE` (EIP-7708). Indexers and monitors must watch this address.
- The mempool enforces a 20 Gwei `maxFeePerGas` floor. Blocklist reverts consume gas without producing a receipt. Sends to `address(0)` revert.
- Finality is deterministic and arrives in under 1s, so transactions are either pending or final and there's no need to wait for confirmations.
- For contracts, use Arc Foundry (`arc-forge`, `arc-cast`, `arc-anvil`).
- Canonical references: https://docs.arc.io/arc/references/evm-differences.md and https://docs.arc.io/arc/references/contract-addresses.md
