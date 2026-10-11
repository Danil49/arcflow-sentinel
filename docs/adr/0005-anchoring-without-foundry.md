# ADR 0005: anchoring without Arc Foundry, on testnet first

Status: accepted (2026-10-11).

**Context.** Third-party programs can't be installed in the development environment, which rules out Arc Foundry and desktop wallets. The only key available is a dedicated MetaMask account with Arc testnet USDC; there is no mainnet USDC.

**Decision.**

- **Compile and test:** compile `EvidenceRegistry.sol` with solc-js. The artifact is committed and checked for drift. Unit-test it on an in-process EVM (`@ethereumjs/evm`).
- **Deploy and anchor:** use viem with `ANCHOR_PRIVATE_KEY`.
- **Arc-specific behaviour:** Arc's EVM differences (USDC as native gas with 18 decimals, blocklist reverts) don't affect a contract that never touches value. Gas behaviour (the 20 Gwei floor) is covered by the live testnet run.
- **Networks:** `ANCHOR_NETWORK` is independent of `CCTP_NETWORK`. Sentinel monitors mainnet while anchoring on testnet. Mainnet anchoring is the last phase.

**Consequences.**

- No native tooling is needed.
- Testnet anchors are clearly labelled.
- If the contract ever handles value, revisit this and test with Arc's own tooling.
