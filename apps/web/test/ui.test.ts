import { describe, expect, it } from "vitest";
import { formatDuration, formatUsdc, humanize, shortHash } from "../src/ui/format.js";
import { headline, isLive, stationsFor } from "../src/ui/stations.js";
import type { TraceView } from "../src/views.js";

const at = (m: number) => new Date(Date.UTC(2026, 9, 7, 20, m));

function view(over: Partial<TraceView["trace"]> = {}, extra: Partial<TraceView> = {}): TraceView {
  return {
    trace: {
      id: "t",
      route: {
        sourceChain: "base",
        sourceDomain: 6,
        destinationChain: "arc",
        destinationDomain: 26,
      },
      sourceTxHash: "0x21",
      sourceLogIndex: 8,
      sourceBlockNumber: "1",
      sourceBlockTime: at(0).toISOString(),
      nonce: null,
      sender: "0x1",
      recipient: "0x2",
      amountAtomic: "5869596",
      status: "SOURCE_OBSERVED",
      progress: "SOURCE_OBSERVED",
      reason: null,
      statusReason: null,
      destinationTxHash: null,
      stageDeadlineAt: null,
      requireAppConfirmation: false,
      applicationConfirmedAt: null,
      applicationReference: null,
      explorer: { source: "https://basescan.org/tx/0x21", destination: null },
      firstSeenAt: at(0).toISOString(),
      updatedAt: at(0).toISOString(),
      ...over,
    },
    events: [],
    attestations: [],
    invariants: [],
    latestEvidence: null,
    anchor: null,
    anchorNetwork: "testnet",
    anchoringEnabled: true,
    signingEnabled: true,
    ...extra,
  };
}

const states = (v: TraceView) => stationsFor(v).map((s) => s.state);

describe("stationsFor", () => {
  it("marks the next unfinished station as current", () => {
    expect(states(view())).toEqual(["done", "current", "upcoming", "upcoming", "upcoming"]);
    expect(stationsFor(view())[1]!.detail).toBe("Waiting for Circle to pick up the burn");
    expect(stationsFor(view({ progress: "FINALITY_WAIT" }))[1]!.detail).toBe(
      "Waiting for Base to finalize the burn",
    );
    expect(states(view({ progress: "ATTESTED" }))).toEqual([
      "done",
      "done",
      "done",
      "current",
      "upcoming",
    ]);
  });

  it("completes the line on mint, or waits on the app when confirmation is required", () => {
    expect(states(view({ progress: "MINT_CONFIRMED" }))).toEqual([
      "done",
      "done",
      "done",
      "done",
      "done",
    ]);
    const needApp = view({ progress: "MINT_CONFIRMED", requireAppConfirmation: true });
    expect(states(needApp)).toEqual(["done", "done", "done", "done", "done", "current"]);
    expect(
      states(view({ progress: "APPLICATION_CONFIRMED", requireAppConfirmation: true })).every(
        (s) => s === "done",
      ),
    ).toBe(true);
  });

  it("shows stuck and failed on the station where progress stopped, with the reason", () => {
    const stuck = stationsFor(
      view({
        progress: "ATTESTED",
        reason: "STUCK",
        statusReason: "ATTESTED for 130m (limit 120m)",
      }),
    );
    expect(stuck[3]).toMatchObject({ state: "stuck", detail: "ATTESTED for 130m (limit 120m)" });
    const failed = stationsFor(
      view({
        progress: "MINT_CONFIRMED",
        reason: "FAILED",
        statusReason: "recipient-integrity: x",
      }),
    );
    expect(failed.map((s) => s.state)).toEqual(["done", "done", "done", "done", "done"]);
  });

  it("labels chain time vs time Sentinel saw it", () => {
    const v = view(
      { progress: "MINT_CONFIRMED" },
      {
        events: [
          {
            chainId: 5042,
            domain: 26,
            blockNumber: "9",
            txHash: "0x52",
            logIndex: 3,
            eventType: "mint",
            removed: false,
            observedAt: at(20),
            explorerUrl: null,
          },
          {
            chainId: 5042,
            domain: 26,
            blockNumber: "9",
            txHash: "0x52",
            logIndex: 4,
            eventType: "message_received",
            removed: true,
            observedAt: at(19),
            explorerUrl: null,
          },
        ],
        attestations: [{ status: "complete", delayReason: null, observedAt: at(18) }],
      },
    );
    const s = stationsFor(v);
    expect(s[0]).toMatchObject({ timeSource: "block", at: at(0) });
    expect(s[2]).toMatchObject({ timeSource: "seen", at: at(18) });
    expect(s[3]!.at).toBeNull(); // the only MessageReceived was dropped by a reorg
    expect(s[4]!.at).toEqual(at(20));
  });
});

describe("headline and liveness", () => {
  it("answers where the transfer is, in words", () => {
    expect(headline(view())).toBe("Left Base, on its way to Arc.");
    expect(headline(view({ progress: "MINT_CONFIRMED" }))).toBe("Arrived on Arc.");
    expect(headline(view({ reason: "STUCK" }))).toBe(
      "This transfer is taking longer than it should.",
    );
    expect(headline(view({ reason: "FAILED" }))).toBe("This transfer failed a safety check.");
  });

  it("stops live refresh only when nothing more can change", () => {
    expect(isLive(view())).toBe(true);
    expect(isLive(view({ reason: "STUCK" }))).toBe(true);
    expect(isLive(view({ reason: "FAILED" }))).toBe(false);
    expect(isLive(view({ progress: "MINT_CONFIRMED" }))).toBe(false);
    expect(isLive(view({ progress: "MINT_CONFIRMED", requireAppConfirmation: true }))).toBe(true);
  });
});

describe("format", () => {
  it("formats atomic USDC exactly", () => {
    expect(formatUsdc("41300343736")).toBe("41,300.343736");
    expect(formatUsdc("30000000")).toBe("30.00");
    expect(formatUsdc("1250000")).toBe("1.25");
    expect(formatUsdc("1")).toBe("0.000001");
    expect(formatUsdc("123456789012345678901234567890")).toBe(
      "123,456,789,012,345,678,901,234.56789",
    );
  });

  it("durations, hashes, and human wording for state names", () => {
    expect(formatDuration(42_000)).toBe("42 s");
    expect(formatDuration(130 * 60_000)).toBe("2 h 10 min");
    expect(shortHash("0x219163cb00c8535d2b3181d4ec4df21ebad0c88e1f6de4708722b735e132e41e")).toBe(
      "0x219163…e41e",
    );
    expect(humanize("ATTESTED for 130m (limit 120m)")).toBe("signed for 130m (limit 120m)");
    expect(humanize("MINT_CONFIRMED has no deadline")).toBe("minted has no deadline");
  });
});
