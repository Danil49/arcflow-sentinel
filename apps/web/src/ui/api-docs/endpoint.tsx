import { cn } from "../format.js";
import { Code } from "./code.js";
import { FieldTable } from "./field-table.js";
import type { DocEndpoint } from "./model.js";

/** One endpoint: what it does, what to send, what comes back, and a call to copy. */
export function Endpoint({ e }: { e: DocEndpoint }) {
  return (
    <section
      id={e.id}
      aria-labelledby={`${e.id}-title`}
      className="scroll-mt-6 border-t border-rule pt-8 pb-4"
    >
      <h3 id={`${e.id}-title`} className="text-lg font-bold">
        {e.title}
      </h3>
      <p className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1 font-mono text-[0.95rem]">
        <span className={cn("font-medium", e.method === "POST" ? "text-accent" : "text-ink")}>
          {e.method}
        </span>
        <span className="break-all">{e.path}</span>
        {e.auth && (
          <span className="rounded-sm border border-ink-soft px-1.5 py-0.5 font-sans text-xs text-ink-soft">
            API key required
          </span>
        )}
      </p>
      <p className="mt-3 max-w-[70ch] leading-relaxed">{e.description}</p>

      {e.params.length > 0 && (
        <FieldTable
          caption="Parameters"
          rows={e.params.map((p) => ({
            name: p.name,
            type: p.type,
            required: p.required,
            description: p.in === "path" ? "In the path." : "In the query string.",
          }))}
        />
      )}
      {e.body && <FieldTable caption="Request body (JSON)" rows={e.body} />}

      <div className="mt-4">
        <p className="text-sm text-ink-soft">Responses</p>
        <dl className="mt-1.5 grid grid-cols-[3.5rem_1fr] gap-x-3 gap-y-1 text-sm">
          {e.responses.map((r) => (
            <div key={r.status} className="contents">
              <dt
                // Colour keeps its platform meaning: green for success, neutral otherwise.
                className={cn("font-mono", r.status.startsWith("2") ? "text-ok" : "text-ink-soft")}
              >
                {r.status}
              </dt>
              <dd>{r.meaning}</dd>
            </div>
          ))}
        </dl>
      </div>

      <Code code={e.curl} label="Example request" />
    </section>
  );
}
