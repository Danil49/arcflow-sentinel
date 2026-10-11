# ADR 0004: evidence bundle format

Status: accepted.

**Context.** Evidence must be verifiable by third parties without trusting Sentinel's UI. Its hash must also stay stable so an on-chain anchor keeps meaning something.

**Decision.**

- The payload is serialized with RFC 8785 (JCS), and SHA-256 and keccak256 are computed over the canonical bytes. The keccak256 is what gets anchored.
- Ed25519 is used via `node:crypto`, so no extra dependencies.
- The payload has no generation timestamp and its collections are sorted, so unchanged evidence produces identical bytes.
- Reorged observations stay in the bundle, flagged.
- Verifiers trust the published key, not the embedded one.

**Consequences.**

- `verify-evidence` is small and auditable.
- A new verdict or observation produces a new bundle. Older anchors remain valid for older bundles, and the UI says so.
