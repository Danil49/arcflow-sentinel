import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));

export const chainName = (key: "base" | "arc") => (key === "arc" ? "Arc" : "Base");

/** 6-decimal atomic USDC -> "41,300.343736" (trailing zeros trimmed, at least 2 decimals). */
export function formatUsdc(atomic: string): string {
  const v = BigInt(atomic);
  const whole = (v / 1_000_000n).toLocaleString("en-US");
  let frac = (v % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  if (frac.length < 2) frac = frac.padEnd(2, "0");
  return `${whole}.${frac}`;
}

export const shortHash = (h: string, head = 6, tail = 4) =>
  h.length <= head + tail + 2 ? h : `${h.slice(0, head + 2)}…${h.slice(-tail)}`;

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h < 48) return rem ? `${h} h ${rem} min` : `${h} h`;
  return `${Math.round(h / 24)} days`;
}

const utc = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  timeZone: "UTC",
  hour12: false,
});
const utcTime = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "UTC",
  hour12: false,
});

export const formatUtc = (d: Date | string) => `${utc.format(new Date(d))} UTC`;
export const formatUtcTime = (d: Date | string) => `${utcTime.format(new Date(d))} UTC`;

export function formatAgo(d: Date | string, now: Date): string {
  const ms = now.getTime() - new Date(d).getTime();
  return ms < 45_000 ? "just now" : `${formatDuration(ms)} ago`;
}

const utcDayTime = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "UTC",
  hour12: false,
});
export const formatUtcDayTime = (d: Date | string) => `${utcDayTime.format(new Date(d))} UTC`;

const STATE_WORDS: Record<string, string> = {
  SOURCE_OBSERVED: "burned",
  FINALITY_WAIT: "finalizing",
  ATTESTATION_PENDING: "awaiting Circle's signature",
  ATTESTED: "signed",
  DESTINATION_SUBMITTED: "received",
  MINT_CONFIRMED: "minted",
  APPLICATION_CONFIRMED: "confirmed by the app",
  FAILED_OR_STUCK: "flagged",
};
/** Replaces lifecycle enum names in machine explanations with words. */
export const humanize = (text: string) =>
  text.replace(
    /\b[A-Z][A-Z_]{4,}\b/g,
    (m) => STATE_WORDS[m] ?? m.toLowerCase().replaceAll("_", " "),
  );
