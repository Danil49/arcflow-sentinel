import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { IrisMessagesResponse, RpcLog } from "../src/index.js";

const root = fileURLToPath(new URL("../../../fixtures/", import.meta.url));

export function loadFixture<T>(path: string): T {
  return JSON.parse(readFileSync(root + path, "utf8")) as T;
}

export const baseToArc = {
  sourceReceipt: loadFixture<{ logs: RpcLog[] }>("base-to-arc-complete/source-receipt.json"),
  destinationReceipt: loadFixture<{ logs: RpcLog[] }>(
    "base-to-arc-complete/destination-receipt.json",
  ),
  iris: loadFixture<IrisMessagesResponse>("base-to-arc-complete/iris-messages.json"),
};

// CCTP V2 contracts share addresses across Base and Arc mainnet.
export const TOKEN_MESSENGER = "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d";
export const MESSAGE_TRANSMITTER = "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64";
export const BASE = { chainId: 8453, domain: 6 };
export const ARC = { chainId: 5042, domain: 26 };
