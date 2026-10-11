/**
 * Deploys EvidenceRegistry to Arc with viem and ANCHOR_PRIVATE_KEY (no Foundry needed).
 * Dry run by default: prints the account, balance and worst-case cost. Add --yes to send.
 *
 *   pnpm --filter @sentinel/contracts deploy --network testnet [--yes]
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createPublicClient, createWalletClient, formatUnits, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { anchorChain, arcFees, type AnchorNetwork } from "@sentinel/chains";
import { evidenceRegistryArtifact, evidenceRegistryBytecode } from "../src/index.js";

const { values } = parseArgs({
  options: { network: { type: "string" }, yes: { type: "boolean" } },
});
if (values.network !== "testnet" && values.network !== "mainnet") {
  console.error("usage: deploy --network testnet|mainnet [--yes]");
  process.exit(2);
}
const network = values.network as AnchorNetwork;
const rpcUrl = network === "mainnet" ? process.env.ARC_RPC_URL : process.env.TESTNET_ARC_RPC_URL;
const key = process.env.ANCHOR_PRIVATE_KEY;
if (!key || !/^(0x)?[0-9a-fA-F]{64}$/.test(key)) {
  console.error("ANCHOR_PRIVATE_KEY is missing or malformed");
  process.exit(2);
}

const cfg = anchorChain(network);
const account = privateKeyToAccount((key.startsWith("0x") ? key : `0x${key}`) as `0x${string}`);
const client = createPublicClient({ chain: cfg.chain, transport: http(rpcUrl) });
const wallet = createWalletClient({ chain: cfg.chain, account, transport: http(rpcUrl) });

const [chainId, balance] = await Promise.all([
  client.getChainId(),
  client.getBalance({ address: account.address }),
]);
if (chainId !== cfg.chain.id)
  throw new Error(`RPC is chain ${chainId}, expected ${cfg.chain.id} (${network})`);
const gas = await client.estimateGas({ account, data: evidenceRegistryBytecode });
const fees = await arcFees(client);
const worstCase = gas * fees.maxFeePerGas;
const usdc = (v: bigint) => `${formatUnits(v, 18)} USDC`;

console.log(`network     Arc ${network} (chain ${chainId})`);
console.log(`deployer    ${account.address}`);
console.log(`balance     ${usdc(balance)}`);
console.log(`gas         ${gas} (max fee ${formatUnits(fees.maxFeePerGas, 9)} gwei)`);
console.log(`worst case  ${usdc(worstCase)}`);
if (balance < worstCase) throw new Error("balance is below the worst-case deployment cost");
if (!values.yes) {
  console.log("\ndry run: re-run with --yes to deploy");
  process.exit(0);
}

const hash = await wallet.deployContract({
  abi: evidenceRegistryArtifact.abi,
  bytecode: evidenceRegistryBytecode,
  gas: (gas * 12n) / 10n,
  ...fees,
});
console.log(`tx          ${cfg.explorerTxUrl(hash)}`);
const receipt = await client.waitForTransactionReceipt({ hash, timeout: 60_000 });
if (receipt.status !== "success" || !receipt.contractAddress)
  throw new Error(`deployment failed: ${receipt.status}`);
const code = await client.getCode({ address: receipt.contractAddress });
if (code !== evidenceRegistryArtifact.deployedBytecode)
  throw new Error("deployed code does not match the artifact");

const cost = receipt.gasUsed * receipt.effectiveGasPrice;
const record = {
  network,
  chainId,
  address: receipt.contractAddress,
  txHash: hash,
  blockNumber: receipt.blockNumber.toString(),
  deployer: account.address,
  gasUsed: receipt.gasUsed.toString(),
  costUsdc: formatUnits(cost, 18),
  compiler: evidenceRegistryArtifact.compiler,
  sourceSha256: evidenceRegistryArtifact.sourceSha256,
  deployedAt: new Date().toISOString(),
};
writeFileSync(
  fileURLToPath(new URL(`../deployments/${network}.json`, import.meta.url)),
  JSON.stringify(record, null, 2) + "\n",
);
console.log(`address     ${cfg.explorerAddressUrl(receipt.contractAddress)}`);
console.log(`cost        ${usdc(cost)} (gas used ${receipt.gasUsed})`);
console.log(
  `\nset in .env:\n  ANCHOR_NETWORK=${network}\n  EVIDENCE_REGISTRY_ADDRESS=${receipt.contractAddress}`,
);
