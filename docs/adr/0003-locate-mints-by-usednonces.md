# ADR 0003: find the destination mint by binary search over usedNonces

Status: accepted.

**Context.** The source-chain `MessageSent` has a zeroed nonce, because Circle assigns it at attestation. Finding the destination `MessageReceived` by nonce would need wide `eth_getLogs` scans, and common RPC tiers cap those at about 10 blocks.

**Decision.**

1. Get the nonce from Iris.
2. Binary-search `MessageTransmitterV2.usedNonces(nonce)` with historical `eth_call`, from the burn's timestamp to the head (about 25 calls).
3. Read logs for that single block.

**Consequences.**

- Tracing works on any RPC tier that serves archive state.
- No dependency on an indexer.
- Passive tailing (`COLLECT`) stays optional.
