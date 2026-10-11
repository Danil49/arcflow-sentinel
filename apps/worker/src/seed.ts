import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { Hex } from "viem";
import { routeChains, type RouteChain } from "@sentinel/chains";
import {
  decodeCctpLogs,
  fromRpcLog,
  parseIrisMessages,
  type BurnObserved,
  type IrisMessagesResponse,
  type RpcLog,
} from "@sentinel/core";
import {
  insertAttestation,
  insertEvents,
  linkTxEvents,
  transferTraces,
  upsertTraceFromBurn,
} from "@sentinel/db";
import { reevaluateTrace, type PipelineDeps } from "./services.js";
import { matchAttestation } from "./steps.js";

interface FixtureMeta {
  network: "mainnet" | "testnet";
  sourceChain: RouteChain;
  destinationChain: RouteChain;
}

/**
 * Loads captured historical transfers (fixtures/<name>/{meta,source-receipt,iris-messages,
 * destination-receipt}.json) as demo traces, with no network calls. Idempotent. Demo traces are
 * flagged `is_demo` and labelled as historical in the UI.
 */
export async function seedDemo(
  deps: Pick<PipelineDeps, "db" | "deadlines" | "now">,
  fixturesDir: string,
): Promise<{ name: string; traceId: string; status: string }[]> {
  const out = [];
  for (const name of readdirSync(fixturesDir).sort()) {
    const dir = join(fixturesDir, name);
    if (!existsSync(join(dir, "meta.json"))) continue;
    const load = <T>(f: string) => JSON.parse(readFileSync(join(dir, f), "utf8")) as T;
    const meta = load<FixtureMeta>("meta.json");
    const chains = routeChains(meta.network);
    const src = chains[meta.sourceChain];
    const dst = chains[meta.destinationChain];
    const decode = (file: string, side: typeof src) =>
      decodeCctpLogs(
        load<{ logs: RpcLog[] }>(file).logs.map((l) => fromRpcLog(l, side.chain.id)),
        side,
      );

    const sourceEvents = decode("source-receipt.json", src);
    const burn = sourceEvents.find((e): e is BurnObserved => e.kind === "burn");
    if (!burn) throw new Error(`fixture ${name}: no burn in source receipt`);
    const destEvents = existsSync(join(dir, "destination-receipt.json"))
      ? decode("destination-receipt.json", dst)
      : [];
    const iris = load<IrisMessagesResponse>("iris-messages.json");

    const traceId = await deps.db.transaction(async (tx) => {
      const { trace } = await upsertTraceFromBurn(tx, burn, "SOURCE_OBSERVED");
      await tx.update(transferTraces).set({ isDemo: true }).where(eq(transferTraces.id, trace.id));
      await insertEvents(tx, sourceEvents, trace.id);
      if (destEvents.length) {
        await insertEvents(tx, destEvents, trace.id);
        await linkTxEvents(tx, trace.id, dst.chain.id, destEvents[0]!.txHash);
      }
      const attestation = matchAttestation(
        parseIrisMessages(iris, src.domain, burn.txHash as Hex, (deps.now ?? (() => new Date()))()),
        burn,
      );
      if (attestation) await insertAttestation(tx, trace.id, attestation, iris);
      return trace.id;
    });
    const { result } = await reevaluateTrace(deps, traceId);
    out.push({ name, traceId, status: result.status });
  }
  return out;
}
