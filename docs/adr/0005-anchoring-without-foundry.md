# ADR 0005: anchoring without Arc Foundry, on testnet first

Status: accepted (2026-10-11).

**Context.** Third-party programs can't be installed in the development environment, which rules out Arc Foundry and desktop wallets. The only key available is a dedicated MetaMask account with Arc testnet USDC; there is no mainnet USDC.

**Decision.**

- **Compile and test:** compile `EvidenceRegistry.sol` with solc-js. The artifact is committed and checked for drift. Unit-test it on an in-process EVM (`@ethereumjs/evm`).
- **Deploy and anchor:** use viem with `ANCHOR_PRIVATE_KEY`.
- **Arc-specific behaviour:** Arc's EVM differences (USDC as native gas with 18 decimals, blocklist reverts) don't affect a contract that never touches value. Gas behaviour (the 20 Gwei floor) is covered by the live testnet run.
- **Networks:** `ANCHOR_NETWORK` is independent of `CCTP_NETWORK`. Sentinel monitors mainnet while anchoring on testnet. Mainnet anchoring is the last phase.

**Outcome (2026-10-12).**

- Once mainnet USDC was available, the same artifact was deployed to Arc mainnet at `0xD37a99DC7a7CA2E3b1A75648886875E50a6b52FF`, for 0.0021 USDC. That's the same address as on testnet, because both deploys were the account's first transaction on their chain.
- A real transfer's evidence was anchored for 0.0005 USDC and verified over the public mainnet RPC.
- The verifier binds anchors to the published chain id, so the shared address can't be used to pass off a testnet anchor as a mainnet one.

**Consequences.**

- No native tooling is needed.
- Testnet anchors are clearly labelled.
- If the contract ever handles value, revisit this and test with Arc's own tooling.
