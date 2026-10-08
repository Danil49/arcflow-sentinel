import { createRouteClient, routeChains, type RouteChain } from "@sentinel/chains";
import type { ChainEnv } from "@sentinel/config";
import type { RouteSide } from "./trace.js";

/** Builds both route sides for the configured network, applying RPC and log-span overrides. */
export function routeSidesFromEnv(env: ChainEnv): Record<RouteChain, RouteSide> {
  const chains = routeChains(env.CCTP_NETWORK);
  const testnet = env.CCTP_NETWORK === "testnet";
  const rpc = {
    arc: testnet ? env.TESTNET_ARC_RPC_URL : env.ARC_RPC_URL,
    base: testnet ? env.TESTNET_BASE_RPC_URL : env.BASE_RPC_URL,
  };
  const chunk = { arc: env.ARC_LOG_CHUNK_SIZE, base: env.BASE_LOG_CHUNK_SIZE };
  const side = (k: RouteChain): RouteSide => {
    const config = { ...chains[k], logChunkSize: chunk[k] ?? chains[k].logChunkSize };
    return { config, client: createRouteClient(config, rpc[k]) };
  };
  return { arc: side("arc"), base: side("base") };
}
