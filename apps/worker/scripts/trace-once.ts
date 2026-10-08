/**
 * Day-1 spike: trace one CCTP V2 transfer end to end and print what each stage shows.
 *
 *   pnpm --filter @sentinel/worker trace-once <sourceTxHash> --from base|arc [--save <fixtureDir>]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { formatUnits, isHash, type Hex } from "viem";
import { bytes32ToAddress } from "@sentinel/core";
import { createRouteClient, IRIS_BASE_URL, routeChains, type RouteChain } from "@sentinel/chains";
import { chainEnvSchema, parseEnv } from "@sentinel/config";
import { createIrisClient, traceOnce } from "../src/index.js";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    from: { type: "string", default: "base" },
    save: { type: "string" },
    "max-blocks": { type: "string", default: "500000" },
  },
});
const [txHash] = positionals;
if (!txHash || !isHash(txHash) || (values.from !== "base" && values.from !== "arc")) {
  console.error("usage: trace-once <sourceTxHash> --from base|arc [--save <dir>] [--max-blocks N]");
  process.exit(2);
}

const env = parseEnv(chainEnvSchema);
const chains = routeChains(env.CCTP_NETWORK);
const from = values.from as RouteChain;
const to: RouteChain = from === "base" ? "arc" : "base";
const rpc = { arc: env.ARC_RPC_URL, base: env.BASE_RPC_URL };
const side = (k: RouteChain) => ({
  config: chains[k],
  client: createRouteClient(chains[k], rpc[k]),
});

const result = await traceOnce(txHash as Hex, {
  source: side(from),
  destination: side(to),
  iris: createIrisClient(env.IRIS_BASE_URL ?? IRIS_BASE_URL[env.CCTP_NETWORK]),
  maxDestinationBlocks: BigInt(values["max-blocks"]),
});

const usdc = (v: bigint) => `${formatUnits(v, 6)} USDC`;
const burn = result.sourceEvents.find((e) => e.kind === "burn")!;
const attestation = result.attestations[0];
const received = result.destinationEvents.find((e) => e.kind === "message_received");
const mint = result.destinationEvents.find((e) => e.kind === "mint");

console.log(`status            ${result.status}`);
console.log(`\nsource (${from}, domain ${chains[from].domain})`);
console.log(`  tx              ${chains[from].explorerTxUrl(burn.txHash)}`);
console.log(`  block           ${burn.blockNumber}`);
console.log(`  depositor       ${burn.depositor}`);
console.log(`  amount          ${usdc(burn.amount)}   maxFee ${usdc(burn.maxFee)}`);
console.log(`  mintRecipient   ${bytes32ToAddress(burn.mintRecipient)}`);
console.log(
  `  route           domain ${burn.domain} -> ${burn.destinationDomain}, minFinality ${burn.minFinalityThreshold}`,
);
console.log(`\nattestation (Iris)`);
if (!attestation) console.log("  not indexed yet");
else {
  console.log(
    `  status          ${attestation.status}${attestation.delayReason ? ` (${attestation.delayReason})` : ""}`,
  );
  console.log(`  nonce           ${attestation.nonce ?? "-"}`);
  if (attestation.message) {
    console.log(`  feeExecuted     ${usdc(attestation.message.body.feeExecuted)}`);
    console.log(`  finalityExec    ${attestation.message.finalityThresholdExecuted}`);
  }
}
console.log(`\ndestination (${to}, domain ${chains[to].domain})`);
if (!result.destinationTxHash) console.log("  no MessageReceived found in scanned range");
else {
  console.log(`  tx              ${chains[to].explorerTxUrl(result.destinationTxHash)}`);
  if (received?.kind === "message_received") console.log(`  received nonce  ${received.nonce}`);
  if (mint?.kind === "mint")
    console.log(
      `  minted          ${usdc(mint.amount)} to ${mint.mintRecipient} (fee ${usdc(mint.feeCollected)})`,
    );
}

if (values.save) {
  mkdirSync(values.save, { recursive: true });
  const write = (name: string, data: unknown) =>
    data && writeFileSync(`${values.save}/${name}.json`, JSON.stringify(data, null, 2) + "\n");
  write("source-receipt", result.raw.sourceReceipt);
  write("iris-messages", result.raw.iris);
  write("destination-receipt", result.raw.destinationReceipt);
  console.log(`\nsaved raw responses to ${values.save}`);
}
