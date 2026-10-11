# Security policy

Please report vulnerabilities privately to the maintainers rather than in a public issue. Include steps to reproduce and the affected version or commit. We aim to acknowledge reports within 3 working days.

In scope:

- The API and UI (`apps/web`)
- The worker (`apps/worker`)
- Evidence signing and verification (`packages/evidence`)
- The `EvidenceRegistry` contract

`docs/threat-model.md` describes the threats we design for and the residual risks we accept.

Never include secrets (RPC URLs with keys, private keys, `.env` contents) in reports or issues.
