/**
 * Prints the anchoring setup and the anchor account's balance (no secrets): use it to find
 * ANCHOR_SUBMITTER_ADDRESS, check funding, and monitor the balance.
 *
 *   pnpm --filter @sentinel/worker anchor-status
 */
import { formatUnits } from "viem";
import { errorText, parseEnv, workerEnvSchema } from "@sentinel/config";
import { anchorerFromEnv } from "../src/index.js";

const env = parseEnv(workerEnvSchema);
const usdc = (v: bigint) => `${formatUnits(v, 18)} USDC`;
console.log(`mode        ${env.ANCHOR_MODE}`);
console.log(`network     ${env.ANCHOR_NETWORK}`);
const a = anchorerFromEnv(env);
if (!a) {
  console.log(
    !env.ANCHOR_PRIVATE_KEY
      ? "status      disabled: ANCHOR_PRIVATE_KEY is not set (worker.env)"
      : env.ANCHOR_MODE === "off"
        ? "status      disabled: ANCHOR_MODE=off"
        : "status      disabled: no registry for this network (set EVIDENCE_REGISTRY_ADDRESS)",
  );
  process.exit(0);
}
console.log(`chain id    ${a.chainId}`);
console.log(`registry    ${a.registry}`);
console.log(`account     ${a.account.address}   <- set ANCHOR_SUBMITTER_ADDRESS to this`);
try {
  const balance = await a.client.getBalance({ address: a.account.address });
  console.log(`balance     ${usdc(balance)}`);
  console.log(`min balance ${usdc(a.minBalanceWei)} (anchoring stops below this)`);
  console.log(`max fee     ${usdc(a.maxFeeWei)} per anchor`);
  console.log(`status      ${balance > a.minBalanceWei ? "ok" : "LOW BALANCE: fund the account"}`);
  process.exit(balance > a.minBalanceWei ? 0 : 1);
} catch (err) {
  console.log(`status      RPC error: ${errorText(err)}`);
  process.exit(1);
}
