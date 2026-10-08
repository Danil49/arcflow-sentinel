import { createPublicClient, http, type PublicClient } from "viem";
import type { RouteChainConfig } from "./networks.js";

export function createRouteClient(config: RouteChainConfig, rpcUrl?: string): PublicClient {
  return createPublicClient({
    chain: config.chain,
    transport: http(rpcUrl, { timeout: 15_000, retryCount: 3 }),
  });
}
