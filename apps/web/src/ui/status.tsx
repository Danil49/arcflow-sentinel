import { cn } from "./format.js";

const WORDS: Record<string, string> = {
  SOURCE_OBSERVED: "Burned",
  FINALITY_WAIT: "Finalizing",
  ATTESTATION_PENDING: "Awaiting signature",
  ATTESTED: "Signed",
  DESTINATION_SUBMITTED: "Received",
  MINT_CONFIRMED: "Minted",
  APPLICATION_CONFIRMED: "Confirmed",
};

/** Status in words. Colour only ever means done / moving / stuck / failed. */
export function StatusText({ progress, reason }: { progress: string; reason: string | null }) {
  const word =
    reason === "FAILED"
      ? "Failed"
      : reason === "STUCK"
        ? `Stuck: ${WORDS[progress]?.toLowerCase() ?? progress}`
        : (WORDS[progress] ?? progress);
  const tone =
    reason === "FAILED"
      ? "text-fail"
      : reason === "STUCK"
        ? "text-stuck"
        : progress === "MINT_CONFIRMED" || progress === "APPLICATION_CONFIRMED"
          ? "text-ok"
          : "text-accent";
  return <span className={cn("font-semibold", tone)}>{word}</span>;
}
