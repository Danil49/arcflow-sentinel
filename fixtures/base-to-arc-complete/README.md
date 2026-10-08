# base-to-arc-complete (historical)

A real, completed CCTP V2 Standard transfer from Base (domain 6) to Arc mainnet (domain 26). The data was captured from public RPCs and the Iris API on 2026-10-07.

- Source tx (Base): `0x219163cb00c8535d2b3181d4ec4df21ebad0c88e1f6de4708722b735e132e41e`
- Destination tx (Arc): `0x5281793bd4fff55ae84529b2e726a05034f45d5bed84454c75b7344135ceec39`
- Nonce: `0x1f73af1b2ee099c698d297119d9f995d70d1682f9247bc5bbb516f8114fe68b5`
- Amount: 5869596 (5.869596 USDC, 6-decimal ERC-20 units). maxFee and feeExecuted are 0. The finality threshold is 2000 (Standard).

In the source `MessageSent` log, the nonce and expirationBlock are zeroed: Circle assigns the nonce offchain. Linking source to destination therefore goes through Iris (source tx → eventNonce) or through matching the message body.
