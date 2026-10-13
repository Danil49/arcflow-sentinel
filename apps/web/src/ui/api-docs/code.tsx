import { CopyButton } from "../copy-button.js";

/**
 * A copyable code block in the platform's sheet style. The copy button sits in a header row above
 * the code, so it never covers text when long lines scroll on small screens.
 */
export function Code({
  code,
  label,
  copy = true,
}: {
  code: string;
  label?: string;
  copy?: boolean;
}) {
  return (
    <div className="mt-3 overflow-hidden rounded-sm border border-rule bg-sheet">
      {(label || copy) && (
        <div className="flex items-center justify-between gap-3 border-b border-rule px-4 py-1.5">
          <span className="text-sm text-ink-soft">{label ?? ""}</span>
          {copy && <CopyButton text={code} />}
        </div>
      )}
      <pre className="overflow-x-auto px-4 py-3 font-mono text-[0.8rem] leading-relaxed">
        <code>{code}</code>
      </pre>
    </div>
  );
}
