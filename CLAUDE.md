# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

Phases 1–4, 5a and 6 of the plan are done:

- 1: skeleton and spike
- 2: persistence, job queue and collectors
- 3: lifecycle reducer, invariants, webhooks and the REST API
- 4: signed evidence bundles, the verifier CLI and the trace UI
- 5a: `EvidenceRegistry` deployed on Arc **testnet** and anchoring wired end to end
- 6: hardening (secret redaction, rate limiting, submitter-checked anchors), demo seed, and docs (README, threat model, ADRs, SECURITY, LICENSE)

Constraints, as of 2026-10-11:

- No third-party programs can be installed (no Arc Foundry, no desktop wallets). npm libraries are fine.
- The only key is a dedicated MetaMask account (`ANCHOR_PRIVATE_KEY`) holding testnet USDC; there is no mainnet USDC.

So Sentinel monitors **mainnet** CCTP while anchoring on **testnet**. Mainnet anchoring is Phase 8, the last phase. Next up is Phase 7 (self-hostable deployment). Other reference files:

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
- Live spike (no DB): `pnpm --filter @sentinel/worker trace-once <sourceTxHash> --from base|arc [--save fixtures/<name>]`.
- DB migrations: `pnpm --filter @sentinel/db migrate`. After a schema change, regenerate them with `pnpm --filter @sentinel/db generate --name <slug>`.
- Worker: `pnpm --filter @sentinel/worker start`. This runs the job loop, plus the collectors listed in `COLLECT`.
- Create a trace without the API: `pnpm --filter @sentinel/worker create-trace <sourceTxHash> --from base|arc`.
- Web/API: `pnpm --filter @sentinel/web dev`, or `build` then `start`. `pnpm --filter @sentinel/web build` must keep passing, because it is the only check that the workspace packages bundle under webpack.
- Example Arc→Base transfers, and how to find more: `docs/discovering-arc-to-base-transfers.md`.
- Contracts (no Foundry):
  - `pnpm --filter @sentinel/contracts compile`: solc-js. Commit `artifacts/`; a test fails if they drift from the source.
  - `pnpm --filter @sentinel/contracts test`: runs on an in-process `@ethereumjs/evm`.
  - `pnpm --filter @sentinel/contracts deploy --network testnet|mainnet [--yes]`: viem with `ANCHOR_PRIVATE_KEY`. It is a dry run without `--yes`, and on success writes `deployments/<network>.json`.
- Evidence:
  - Generate a signing key with `pnpm --filter @sentinel/evidence keygen`. It prints `EVIDENCE_SIGNING_KEY` and the public key.
  - Verify a bundle with `pnpm --filter @sentinel/evidence verify-evidence <bundle.json> --key-url <site>/.well-known/sentinel-key.json [--anchor-tx <hash>]`, or pass `--public-key <hex>`. Exit codes: 0 valid, 1 invalid, 2 usage or read error.
  - With `--anchor-tx`, the registry and chain come from the published key file. Without `--rpc`, the CLI uses the chain's public RPC.
- Scripts read the root `.env` (see `.env.example`). Variables already set in the shell take precedence over it.
- The `db` and `worker` tests start Postgres through testcontainers (`postgres:17-alpine`). They work with Podman via `/var/run/docker.sock`; Ryuk is disabled automatically.

## Code layout

- `packages/core`: pure domain logic with no I/O.
  - CCTP V2 ABIs
  - The message header/body decoder
  - `decodeCctpLogs` (only trusts logs from the configured CCTP contract addresses)
  - The Iris response parser
  - Domain event types and the lifecycle state enum
- `packages/chains`: per-network route config (Arc and Base addresses, domains, USDC, log chunk sizes, with source-doc comments), viem clients, `findBlockAtOrAfter`, and `getLogsChunked`.
- `packages/config`: zod env parsing. Errors name the variables but never echo their values.
- `packages/db`: Drizzle schema plus generated SQL migrations in `drizzle/`, the repositories, and the job queue (`jobs.ts`). `@sentinel/db/testing` exports `startTestDb()`.
  - All writes are idempotent upserts.
  - Rows dropped by a reorg are marked `removed`, never deleted. Re-observing the same log revives the row.
  - A job's `dedupeKey` is unique only while the job is queued or running.
- `apps/worker`: I/O shells over core. Deps are injected, so tests use the fakes in `test/fakes.ts`.
  - `steps.ts`: the reusable trace steps.
  - `services.ts`:
    - `createTraces` is idempotent and enqueues `trace.refresh`.
    - `refreshTrace` is incremental and returns either `done` or `wait`. A `wait` carries the next payload, such as how far the destination chain has been searched.
  - `collector.ts`: tails the CCTP contracts.
    - The cursor, block hashes, events and `trace.create` jobs commit in one transaction (an outbox), so a crash re-reads the chunk instead of skipping or duplicating it.
    - Reorg checks are on for Base and off for Arc, which has deterministic finality.
  - `runner.ts`: the job loop. A `wait` result requeues the job and resets its attempt counter. Only thrown errors count toward dead-lettering.

- `packages/core/src/lifecycle.ts`: `reduceLifecycle(ctx, events, now, deadlines)` is the **only** place status is decided.
  - It is pure. It dedupes by log identity, so input order and repetition don't matter, and adding evidence never moves progress backwards.
  - `status` is the progress stage, or `FAILED_OR_STUCK` with a `reason`:
    - `FAILED` means an integrity invariant failed. It is terminal.
    - `STUCK` means a stage deadline passed. It is not terminal, and the trace recovers when evidence arrives.
  - When sources disagree about the same log, that's reported as an anomaly. It makes the integrity invariants `UNKNOWN`; it never produces `FAILED`.
  - If no attested message matches the burn, all messages are still evaluated, so a tampered message gets caught instead of filtered out.
  - Deadlines are measured from chain or observation time. Defaults are in `DEFAULT_DEADLINES`; override them with `STAGE_DEADLINES_JSON` (minutes).
- `APPLICATION_CONFIRMED` is opt-in per trace (`requireAppConfirmation`, which needs an API key). The integrating app sets it with an authenticated `POST /api/traces/{id}/confirm`. Without the opt-in, `MINT_CONFIRMED` is the terminal success state.
- Persistence: `saveLifecycle` locks the trace row, upserts the invariant results, and calls the webhook outbox in the same transaction.
- `refreshTrace` persists only after fetching evidence, so a late-submitted old burn is never reported `STUCK` before it has been looked at.
- Webhooks (`apps/worker/src/webhooks.ts`):
  - Endpoints come from env (`WEBHOOK_URLS`). There's one `webhook_deliveries` row per (event, URL) and one `webhook.deliver` job per row.
  - Each delivery is signed: `x-sentinel-signature: v1=HMAC(secret, "${ts}.${body}")`.
  - Delivery is in sequence order per (trace, URL). Redirects are never followed. A delivery is marked dead after 10 attempts.
- `apps/web`: Next.js 15 route handlers in `app/api/**/route.ts`. They are thin wrappers over `src/api/*.ts`, which take an injected `ApiContext`, so tests call them directly.
  - Errors are RFC 7807 problems. Internal errors return only an error id.
  - Privileged endpoints use `Authorization: Bearer <API_KEYS entry>`.
  - `GET /api/openapi.json` is generated from the same zod schemas the handlers validate with.
  - Migrations live behind the `@sentinel/db/migrate` subpath so the web bundle never includes the SQL folder.

- `packages/evidence`: RFC 8785 canonicalization (`canonical.ts`), Ed25519 via `node:crypto` (`keys.ts`, no extra dependencies), and `sealEvidence`/`verifyEvidence` (`bundle.ts`).
  - The payload deliberately has **no generation timestamp**, and its collections are sorted. Unchanged evidence therefore produces byte-identical bundles, so a keccak256 anchored on Arc stays meaningful. Don't add volatile fields such as `evaluatedAt`.
  - Verification must use the operator's published key, never the key embedded in the bundle.
  - `apps/worker/src/evidence.ts` assembles the payload from DB rows, including reorged (`removed`) events. Bundles are stored in `evidence_bundles`, one row per (trace, keccak256).
- Anchoring:
  - `packages/contracts`: the emit-only `EvidenceRegistry.sol`, typed ABI, stable `ANCHOR_STATUS` codes (append-only), and committed deployments. `registryAddress()` defaults to the deployment file.
  - `apps/worker/src/anchor.ts`:
    - Under a per-account advisory lock it seals, signs, persists the raw tx, and only then broadcasts.
    - Resuming after a crash rebroadcasts the same tx, so an anchor is never sent twice. One anchor per (trace, keccak256).
    - It enforces the `ANCHOR_MAX_FEE_USDC` and `ANCHOR_MIN_BALANCE_USDC` caps and keeps `maxFeePerGas` at or above Arc's 20 Gwei floor.
  - The web app never holds the anchor key: `POST /api/traces/{id}/anchor` only queues `evidence.anchor`.
  - Testnet registry: `0xD37a99DC7a7CA2E3b1A75648886875E50a6b52FF` (chain 5042002). The deploy cost 0.0034 USDC; an anchor costs about 0.0008 USDC.
- UI (`apps/web/app`, `src/ui`): server components read the DB through `src/views.ts`. There are no chain calls at render time.
  - `stations.ts` maps a trace onto the route line. Its tests are in `test/ui.test.ts`.
  - `LiveRefresh` re-renders every 5 s while the trace can still change.
  - The design tokens are in `app/globals.css`, with matching light and dark palettes.
  - Don't apply tabular figures (`tnum` / `tabular-nums`) to text set in Schibsted Grotesk: the font widens punctuation under it.

- Security conventions:
  - **Every** error that is logged or persisted goes through `errorText()` or `redact()` from `@sentinel/config`. viem errors embed RPC URLs, and the API key lives in the URL path. `parseEnv` registers secret env values automatically.
  - Anonymous `POST /api/traces` is rate limited per client and globally (`rate_limit_windows`). `X-Forwarded-For` is used only with `TRUST_PROXY=true`.
  - Verifiers check the anchor emitter (the registry) and its submitter (`ANCHOR_SUBMITTER_ADDRESS`, published in the key file), because the registry is permissionless.
- Demo data: `pnpm --filter @sentinel/worker seed-demo` loads `fixtures/*/meta.json` dirs offline as `is_demo` traces. The UI labels them historical.
- Docs: `README.md`, `docs/threat-model.md`, `docs/adr/`, `SECURITY.md`.

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
- RPC limits:
  - The configured paid RPCs are on a free tier that caps `eth_getLogs` at a **10-block** range. Set `ARC_LOG_CHUNK_SIZE`/`BASE_LOG_CHUNK_SIZE` to match.
  - Base's public RPC caps the range at 500 blocks. Both public RPCs rate-limit bursts.
  - Never design a feature around wide log scans. To find a destination mint, binary-search `MessageTransmitterV2.usedNonces(nonce)` with historical `eth_call` (`findNonceUsedBlock`, about 25 calls), then read logs from that single block. This needs archive state, which the paid RPCs have.
- Block times: Arc ≈ 0.51 s, Base ≈ 2.0 s.

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
- Contracts are Solidity, compiled with solc-js and deployed with viem (no Foundry; see the Arc notes below).

The phase-by-phase plan is in `~/.claude/plans/frolicking-stargazing-snowflake.md`.

## Tooling and permissions

`.claude/settings.json` allowlists pnpm and turbo commands (Arc Foundry is not used). Editing `pnpm-lock.yaml` and `.env` is denied: change dependencies through pnpm. `git push`, `--no-verify` commits, and hard resets are denied.

## Arc domain notes (from docs-references.md)

The project targets Arc, Circle's L1 chain. Use the `circle:use-arc` skill and other `circle:*` skills for Arc/USDC work. Arc behaves differently from Ethereum in ways that cause bugs:

- USDC is the native gas token and uses **18 decimals natively**. The ERC-20 USDC interface uses 6 decimals.
- All native USDC Transfer events are emitted by the system address `0xffffFFFfFFffffffffffffffFfFFFfffFFfFFfFE` (EIP-7708). Indexers and monitors must watch this address.
- The mempool enforces a 20 Gwei `maxFeePerGas` floor. Blocklist reverts consume gas without producing a receipt. Sends to `address(0)` revert.
- Finality is deterministic and arrives in under 1s, so transactions are either pending or final and there's no need to wait for confirmations.
- Arc docs recommend Arc Foundry. This project can't install it, so it compiles with solc-js, tests on an in-process EVM, and deploys with viem. That's sound only because `EvidenceRegistry` never touches value or USDC; recheck if the contract grows.
- Canonical references: https://docs.arc.io/arc/references/evm-differences.md and https://docs.arc.io/arc/references/contract-addresses.md
