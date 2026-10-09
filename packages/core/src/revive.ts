import type { Hex } from "viem";
import type { BurnMessageV2 } from "./message.js";
import type { ChainEvent } from "./types.js";
import type { JsonValue } from "./json.js";

type Json = Record<string, JsonValue>;

const big = (v: JsonValue | undefined) => BigInt(v as string);

function reviveBurnMessage(m: Json): BurnMessageV2 {
  const body = m.body as Json;
  return {
    ...(m as unknown as BurnMessageV2),
    body: {
      ...(body as unknown as BurnMessageV2["body"]),
      amount: big(body.amount),
      maxFee: big(body.maxFee),
      feeExecuted: big(body.feeExecuted),
      expirationBlock: big(body.expirationBlock),
    },
  };
}

/** Inverse of toJsonSafe for ChainEvent: restores bigint fields from their decimal strings. */
export function reviveChainEvent(json: JsonValue, observedAt?: Date): ChainEvent {
  const j = json as Json;
  const base = {
    ...(j as unknown as ChainEvent),
    blockNumber: big(j.blockNumber),
    ...(observedAt ? { observedAt } : {}),
  };
  switch (j.kind) {
    case "burn":
      return { ...base, kind: "burn", amount: big(j.amount), maxFee: big(j.maxFee) } as ChainEvent;
    case "mint":
      return {
        ...base,
        kind: "mint",
        amount: big(j.amount),
        feeCollected: big(j.feeCollected),
      } as ChainEvent;
    case "message_sent":
      return {
        ...base,
        kind: "message_sent",
        message: reviveBurnMessage(j.message as Json),
      } as ChainEvent;
    case "message_received":
      return base as ChainEvent;
    default:
      throw new Error(`unknown chain event kind: ${String(j.kind)}`);
  }
}

export const eventKey = (e: { chainId: number; txHash: Hex; logIndex: number }) =>
  `${e.chainId}:${e.txHash.toLowerCase()}:${e.logIndex}`;
