import type { TraceView } from "../views.js";
import { chainName } from "./format.js";

export type StationState = "done" | "current" | "stuck" | "failed" | "upcoming";

export interface Station {
  key: "burned" | "finalized" | "attested" | "received" | "minted" | "confirmed";
  label: string;
  state: StationState;
  /** When it happened; `source` says whether that is chain time or when Sentinel saw it. */
  at: Date | null;
  timeSource: "block" | "seen" | null;
  detail: string | null;
}

const PROGRESS_DONE: Record<string, number> = {
  SOURCE_OBSERVED: 1,
  FINALITY_WAIT: 1,
  ATTESTATION_PENDING: 2,
  ATTESTED: 3,
  DESTINATION_SUBMITTED: 4,
  MINT_CONFIRMED: 5,
  APPLICATION_CONFIRMED: 6,
};

/** Maps a trace onto the stations of the route line. Pure; derived from the view only. */
export function stationsFor(view: TraceView): Station[] {
  const { trace, events, attestations } = view;
  const source = chainName(trace.route.sourceChain);
  const destination = chainName(trace.route.destinationChain);
  const firstSeen = (type: string) =>
    events.find((e) => e.eventType === type && !e.removed)?.observedAt ?? null;
  const attestedAt = attestations.find((a) => a.status === "complete")?.observedAt ?? null;

  const all: Omit<Station, "state" | "detail">[] = [
    {
      key: "burned",
      label: `Burned on ${source}`,
      at: trace.sourceBlockTime ? new Date(trace.sourceBlockTime) : null,
      timeSource: "block",
    },
    { key: "finalized", label: `${source} finality`, at: null, timeSource: null },
    { key: "attested", label: "Attested by Circle", at: attestedAt, timeSource: "seen" },
    {
      key: "received",
      label: `Received on ${destination}`,
      at: firstSeen("message_received"),
      timeSource: "seen",
    },
    { key: "minted", label: `Minted on ${destination}`, at: firstSeen("mint"), timeSource: "seen" },
  ];
  if (trace.requireAppConfirmation) {
    all.push({
      key: "confirmed",
      label: "Confirmed by your app",
      at: trace.applicationConfirmedAt ? new Date(trace.applicationConfirmedAt) : null,
      timeSource: "seen",
    });
  }

  const done = Math.min(PROGRESS_DONE[trace.progress] ?? 0, all.length);
  const flagged = trace.reason === "FAILED" ? "failed" : trace.reason === "STUCK" ? "stuck" : null;
  return all.map((s, i): Station => {
    if (i < done) return { ...s, state: "done", detail: null };
    if (i === done) {
      return {
        ...s,
        state: flagged ?? "current",
        detail: trace.statusReason ?? waitingFor(s.key, trace.progress, source, destination),
      };
    }
    return { ...s, state: "upcoming", detail: null };
  });
}

function waitingFor(
  key: Station["key"],
  progress: string,
  source: string,
  destination: string,
): string {
  switch (key) {
    case "finalized":
      return progress === "SOURCE_OBSERVED"
        ? "Waiting for Circle to pick up the burn"
        : `Waiting for ${source} to finalize the burn`;
    case "attested":
      return "Final; waiting for Circle's signature";
    case "received":
      return `Signed; waiting for someone to submit it on ${destination}`;
    case "minted":
      return "Message received but no mint seen yet";
    case "confirmed":
      return "Waiting for your app to confirm it credited the funds";
    default:
      return "";
  }
}

/** One sentence answering "where is my transfer?". */
export function headline(view: TraceView): string {
  const t = view.trace;
  const destination = chainName(t.route.destinationChain);
  const source = chainName(t.route.sourceChain);
  if (t.reason === "FAILED") return `This transfer failed a safety check.`;
  if (t.reason === "STUCK") return `This transfer is taking longer than it should.`;
  switch (t.progress) {
    case "APPLICATION_CONFIRMED":
      return `Arrived on ${destination}, and your app confirmed it.`;
    case "MINT_CONFIRMED":
      return t.requireAppConfirmation
        ? `Arrived on ${destination}. Waiting for your app to confirm.`
        : `Arrived on ${destination}.`;
    case "DESTINATION_SUBMITTED":
      return `The transfer reached ${destination}; the mint is not visible yet.`;
    case "ATTESTED":
      return `Circle signed the transfer. It can now be minted on ${destination}.`;
    case "ATTESTATION_PENDING":
      return `The burn is final. Circle has not signed it yet.`;
    default:
      return `Left ${source}, on its way to ${destination}.`;
  }
}

export const isLive = (view: TraceView) =>
  view.trace.reason !== "FAILED" &&
  view.trace.progress !== "APPLICATION_CONFIRMED" &&
  !(view.trace.progress === "MINT_CONFIRMED" && !view.trace.requireAppConfirmation);
