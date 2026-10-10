import type { Station, StationState } from "./stations.js";
import { cn, formatUtcDayTime, humanize } from "./format.js";

const dot: Record<StationState, string> = {
  done: "bg-ink border-ink",
  current: "bg-sheet border-accent station-live",
  stuck: "bg-stuck-wash border-stuck",
  failed: "bg-fail border-fail",
  upcoming: "bg-sheet border-rule",
};

const label: Record<StationState, string> = {
  done: "text-ink",
  current: "text-accent",
  stuck: "text-stuck",
  failed: "text-fail",
  upcoming: "text-ink-soft",
};

const stateText: Record<StationState, string> = {
  done: "done",
  current: "in progress",
  stuck: "stuck",
  failed: "failed",
  upcoming: "not yet",
};

/** Segment from a station to the next one: solid ink when travelled, dashed amber into a stall. */
function segmentClass(from: Station, to: Station): string {
  if (to.state === "done") return "bg-ink";
  if (to.state === "stuck") return "seg-stuck";
  if (to.state === "failed") return "bg-fail";
  if (to.state === "current") return "seg-live";
  return "bg-rule";
}

/**
 * The route as a transit line: one station per lifecycle step, travelled track drawn solid up to
 * the current station. Horizontal from md up, vertical on small screens. It is an ordered list,
 * so assistive tech gets the sequence and each station's state in words.
 */
export function RouteRail({ stations }: { stations: Station[] }) {
  return (
    <ol className="grid md:grid-flow-col md:auto-cols-fr" aria-label="Transfer progress">
      {stations.map((s, i) => {
        const next = stations[i + 1];
        return (
          <li key={s.key} className="relative flex gap-4 pb-9 last:pb-0 md:block md:pb-0">
            {next && (
              <span
                aria-hidden
                className={cn(
                  "absolute left-[10.5px] top-6 bottom-0 w-[3px]",
                  "md:left-6 md:right-0 md:top-[10.5px] md:bottom-auto md:h-[3px] md:w-auto",
                  segmentClass(s, next),
                )}
              />
            )}
            <span
              aria-hidden
              className={cn(
                "relative z-10 block size-6 shrink-0 rounded-full border-[3px]",
                dot[s.state],
              )}
            />
            <div className="min-w-0 md:mt-4 md:pr-5">
              <p className={cn("font-semibold leading-snug", label[s.state])}>
                {s.label}
                <span className="sr-only">: {stateText[s.state]}</span>
              </p>
              {s.at && (
                <p className="mt-1 text-sm text-ink-soft">
                  {s.timeSource === "seen" ? "Seen " : ""}
                  <time dateTime={s.at.toISOString()}>{formatUtcDayTime(s.at)}</time>
                </p>
              )}
              {s.detail && (
                <p
                  className={cn(
                    "mt-2 max-w-[30ch] text-sm leading-relaxed",
                    s.state === "failed"
                      ? "text-fail"
                      : s.state === "stuck"
                        ? "text-stuck"
                        : "text-ink-soft",
                  )}
                >
                  {humanize(s.detail)}
                </p>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
