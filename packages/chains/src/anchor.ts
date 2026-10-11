import { parseGwei, parseUnits, type Chain, type PublicClient } from "viem";
import { arc, arcTestnet } from "viem/chains";

export type AnchorNetwork = "testnet" | "mainnet";

export interface AnchorChainConfig {
  network: AnchorNetwork;
  chain: Chain;
  explorerTxUrl: (hash: string) => string;
  explorerAddressUrl: (address: string) => string;
}

export function anchorChain(network: AnchorNetwork): AnchorChainConfig {
  const chain = network === "mainnet" ? arc : arcTestnet;
  const base = chain.blockExplorers!.default.url;
  return {
    network,
    chain,
    explorerTxUrl: (h) => `${base}/tx/${h}`,
    explorerAddressUrl: (a) => `${base}/address/${a}`,
  };
}

/** Arc's mempool rejects or strands transactions whose maxFeePerGas is below 20 Gwei. */
export const ARC_MIN_MAX_FEE_PER_GAS = parseGwei("20");

/** Native USDC on Arc has 18 decimals (the ERC-20 view has 6). */
export const parseNativeUsdc = (amount: string) => parseUnits(amount, 18);

/** EIP-1559 fees for Arc: the node's estimate, never below the protocol floor. */
export async function arcFees(client: PublicClient) {
  const est = await client.estimateFeesPerGas();
  const maxPriorityFeePerGas = est.maxPriorityFeePerGas;
  const maxFeePerGas =
    est.maxFeePerGas > ARC_MIN_MAX_FEE_PER_GAS
      ? est.maxFeePerGas
      : ARC_MIN_MAX_FEE_PER_GAS + maxPriorityFeePerGas;
  return { maxFeePerGas, maxPriorityFeePerGas };
}
