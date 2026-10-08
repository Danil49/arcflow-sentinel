import type { Address, Chain } from "viem";
import { arc, arcTestnet, base, baseSepolia } from "viem/chains";

export type CctpNetwork = "mainnet" | "testnet";
export type RouteChain = "arc" | "base";

export interface RouteChainConfig {
  key: RouteChain;
  chain: Chain;
  /** CCTP domain id. */
  domain: number;
  tokenMessenger: Address;
  messageTransmitter: Address;
  /** USDC ERC-20 (6 decimals on both chains; Arc's native gas balance is 18 decimals). */
  usdc: Address;
  explorerTxUrl: (hash: string) => string;
  /** Max eth_getLogs block span the default public RPC accepts. */
  logChunkSize: bigint;
}

/*
 * Sources (checked 2026-10-07; re-check before changing, never copy from blogs):
 * - Arc: https://docs.arc.io/arc/references/contract-addresses.md
 * - Base / domains: https://developers.circle.com/cctp/references/contract-addresses
 *   and https://developers.circle.com/cctp/concepts/supported-chains-and-domains.md
 * - Base USDC: https://developers.circle.com/stablecoins/usdc-contract-addresses
 * CCTP V2 is deployed at the same addresses on every EVM chain within a network.
 */
const CCTP_V2: Record<CctpNetwork, { tokenMessenger: Address; messageTransmitter: Address }> = {
  mainnet: {
    tokenMessenger: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d",
    messageTransmitter: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64",
  },
  testnet: {
    tokenMessenger: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA",
    messageTransmitter: "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275",
  },
};

export const IRIS_BASE_URL: Record<CctpNetwork, string> = {
  mainnet: "https://iris-api.circle.com",
  testnet: "https://iris-api-sandbox.circle.com",
};

export const ARC_DOMAIN = 26;
export const BASE_DOMAIN = 6;

export function routeChains(network: CctpNetwork): Record<RouteChain, RouteChainConfig> {
  const cctp = CCTP_V2[network];
  const mainnet = network === "mainnet";
  return {
    arc: {
      key: "arc",
      chain: mainnet ? arc : arcTestnet,
      domain: ARC_DOMAIN,
      ...cctp,
      usdc: "0x3600000000000000000000000000000000000000",
      logChunkSize: 5_000n,
      explorerTxUrl: (h) => `${(mainnet ? arc : arcTestnet).blockExplorers!.default.url}/tx/${h}`,
    },
    base: {
      key: "base",
      chain: mainnet ? base : baseSepolia,
      domain: BASE_DOMAIN,
      ...cctp,
      usdc: mainnet
        ? "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
        : "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      logChunkSize: 500n,
      explorerTxUrl: (h) => `${(mainnet ? base : baseSepolia).blockExplorers!.default.url}/tx/${h}`,
    },
  };
}

export function chainByDomain(network: CctpNetwork, domain: number): RouteChainConfig | undefined {
  return Object.values(routeChains(network)).find((c) => c.domain === domain);
}
