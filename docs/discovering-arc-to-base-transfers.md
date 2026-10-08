# Discovering Arc→Base CCTP V2 transfers with Alchemy

Use this to find real, historical Arc→Base transfers for fixtures, demos and manual testing. It is dev tooling, not a production discovery path. The worker keeps using trace-driven lookups (Iris plus the `usedNonces` binary search) and the optional log collector.

## Why a special method is needed

- The Alchemy free tier caps `eth_getLogs` at a **10-block** range. Public RPCs rate-limit too. Scanning CCTP logs over days of blocks is therefore not viable.
- Searching from the Arc side doesn't work. Burn transactions on Arc don't appear as ERC-20 transfers in Alchemy's Transfers API. Queries for Arc USDC (`0x3600…0000`) and the EIP-7708 system emitter (`0xffff…fffe`), in either direction with TokenMessengerV2, return nothing. A likely reason is that USDC is Arc's native gas token.
- Searching from the Base side works. Every CCTP mint on Base is a USDC `Transfer` from `0x0`. Alchemy's Transfers API (`alchemy_getAssetTransfers`) indexes those transfers with no block-range limit.

Support notes, observed on 2026-10-08:

- `alchemy_getAssetTransfers` answered live on both `base-mainnet` and `arc-mainnet`.
- Alchemy's docs don't list Arc mainnet for the Transfers API, so don't rely on Arc support there.

References:

- [Transfers API quickstart](https://www.alchemy.com/docs/reference/transfers-api-quickstart)
- [`alchemy_getAssetTransfers`](https://www.alchemy.com/docs/reference/alchemy-getassettransfers)

## Method

### 1. List recent Base USDC mints

Send this to `https://base-mainnet.g.alchemy.com/v2/$ALCHEMY_API_KEY`:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "alchemy_getAssetTransfers",
  "params": [
    {
      "fromBlock": "0x0",
      "toBlock": "latest",
      "fromAddress": "0x0000000000000000000000000000000000000000",
      "contractAddresses": ["0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"],
      "category": ["erc20"],
      "withMetadata": true,
      "order": "desc",
      "maxCount": "0x64"
    }
  ]
}
```

- To get older results, pass the returned `pageKey` in the next request. Page keys expire after about 10 minutes. `maxCount` can be at most `0x3e8` (1000).
- These are all USDC mints on Base, from every CCTP source domain and from Circle's own issuance. Only a small share come from Arc: in the run below, 8 of 311 mint transactions.

### 2. Keep only mints whose source is Arc

For each distinct `hash`, call `eth_getTransactionReceipt` and keep the receipt if it contains a log with all of the following:

- `address` = `0x81D40F21F12A8F0E3252Bccb954D722d4c464B64` (MessageTransmitterV2)
- `topics[0]` = `0xff48c13eda96b1cceacc6b9edeedc9e9db9d6226afbc30146b720c19d3addb1c` (`MessageReceived`)
- The first 32-byte word of `data` (`sourceDomain`) = `26` (Arc)

`topics[2]` of that log is the CCTP nonce.

This step costs one receipt call per candidate, which is fine for occasional use but shouldn't run in a loop.

### 3. Get the Arc source tx from Iris

```
GET https://iris-api.circle.com/v2/messages/26?nonce=<nonce>
```

The response's `sourceTxHash` is the Arc burn. `messages[0].decodedMessage` gives the domains, amount, fees and recipient. Iris needs no API key.

### 4. Verify end to end

```
npx pnpm@10.18.3 --filter @sentinel/worker trace-once <arcSourceTx> --from arc [--save fixtures/<name>]
```

This should print `MINT_CONFIRMED`, and the Base mint tx it prints should match the table below. The `--save` flag captures the receipts and the Iris response as a fixture.

## Transfers found (2026-10-08 21:38 UTC)

Recent mints from 4 pages of results (311 mint transactions) on Base mainnet were searched, and every pair below was confirmed through Iris:

- Iris `status` is `complete`.
- The route is domain 26 → 6.
- `finalityThresholdExecuted` is 2000 (Standard transfer).
- `feeExecuted` is 0.

Amounts are in USDC, with 6 decimals. The first pair was also traced end to end with `trace-once` and reached `MINT_CONFIRMED`.

| Arc source tx                                                        | Base mint tx                                                         | Base block | Nonce                                                                | Amount        | Mint recipient                               |
| -------------------------------------------------------------------- | -------------------------------------------------------------------- | ---------- | -------------------------------------------------------------------- | ------------- | -------------------------------------------- |
| `0xf2b45ee11be4e44ba04a9b5cb0aee99c1cb7a0b4bca42814bd146feb198c5432` | `0x7f52d824362e3ebab230b3103a840cc93fbc5709998988a52be45f48fa5dc88d` | 52351989   | `0x864ff6a54157a83ee0045f63d23ce9e43b1c4c895a4c63423f075c382cbd8c5f` | 41,300.343736 | `0xef1ec136931ab5728b0783fd87d109c9d15d31f1` |
| `0xcdb5230018725441dc4a7d447cc0d478c718bd0f5f53fa0f6e6d7b26052a1ff1` | `0x8f375c12796264ad580f0241b9285b0778f0490f235e5ecf9ea8b614f3f1abdf` | 52353057   | `0x10ae284bfff85f201c7558a246ab1f2e39bcf0a08ba803a1efe22b9f4427099a` | 1,515.082392  | `0x258e8e1cb3f4f5915671fe9da06bd8a4a63fe692` |
| `0xaedefa8faf3c6d3351ecf1ce696f353e33996d92736d409b7897afd908d6f304` | `0xe1bb511ecdfd16195583e8744d4411495fa764969843b900983cfbedd96e3d51` | 52351555   | `0x783c6bfb48f9cb6e1dd25975067a6b6fd5bceff64dd8330bc46bab6d6a5d0828` | 23,007.415799 | `0xe08abae81ad4282145e9b976244a7fcb0f8e2dfc` |
| `0xd078ea0b3d6f00f125495c315d253cb07cf9e5e587d0a233a89dd6aee040dd24` | `0xaad95fd9102e932f95fa894445f17df7fd4bbfa87974652aeda8dbd357618a7e` | 52351065   | `0xc7c9a5794ee9e55527f2c583199a7ba3d5fe3cb97d1ff390036fe6fc1307c271` | 30.000000     | `0xc43a493e063365f31e54ce14d3ff2f1b7540d516` |
| `0x01170b423a36487ed809087b812b96ce30fb1221a75c21940a25e0b74f39ec5a` | `0x8869225b9a3b3e479cdda072fcf8b642b86056cdc40aa907248d47a4595bbb8a` | 52350506   | `0xdfc665837e876fb80663ebe415e4c926144164180e9ee368e35605e572bbdf93` | 13.000000     | `0xaaf2196e7dc69a388517ab1bb3ddebb704ab856b` |
| `0xc0433a34f3e93c02a88413db4f2a4c5fbf44f30dad51d7b98be11b8a568fcbb7` | `0x547533022b2787c0fd99895f85991d10b1ac2d0dee257e9f7a26c0bbc57b5ae8` | 52350270   | `0x61e70ec1e9c0c8a2e3de626f594a5b499fa623f5a219fca507e326803f95f1cb` | 22,027.662474 | `0xfd03abcadaf3f930fa4e37eb2f6ea3a44a41b7f0` |
| `0xeb57b40e0938bf1442db1f8ce1e48825c720dc7fcb5ffdc6df43563c5d019e81` | `0xa9dac9b60fac5c1012298e41484dea42099e95f5227b316b797f04592dd71db2` | 52350061   | `0x091772964e87549d9b1d21a3133e2a8b76c12f5111938658753d00ff9d0212e8` | 20.000000     | `0xc43a493e063365f31e54ce14d3ff2f1b7540d516` |
| `0xa5d9477d4bfbb1932af2ff29fb22e4689ec930c87b4e122f0c6495a4b326fc3f` | `0xdc408dccbc9993140cf415cc4c20b5a724fd7e1c0fe5905c2cdfd2eb8ebf803c` | 52349888   | `0x66035456d0b3fdd23d3ff093cb7e4c6afd45bdeb909bbcf428581041e24295fe` | 1.250000      | `0x536a844ef215dd8a13a06023f24a568e4ee3cb6b` |

Notes:

- **Count:** the first search found 7 pairs. This re-run found 8, because the 1,515.082392 USDC transfer is newer.
- **Explorer links:** `https://explorer.arc.io/tx/<arcTx>` and `https://basescan.org/tx/<baseTx>`.
- **No fees:** every pair here has `feeExecuted = 0`, so none of them exercises the value-conservation invariant with a fee. For that, look for a Fast transfer (`finalityThresholdExecuted` ≤ 1000) whose `feeExecuted` is non-zero.
