import type { FieldRow } from "./schema-fields.js";

export function FieldTable({ rows, caption }: { rows: FieldRow[]; caption: string }) {
  return (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full min-w-[34rem] table-fixed border-collapse text-left text-sm">
        {/* Fixed columns so every table on the page lines up. */}
        <colgroup>
          <col className="w-[30%]" />
          <col className="w-[22%]" />
          <col />
        </colgroup>
        <caption className="mb-1.5 text-left text-ink-soft">{caption}</caption>
        <thead className="border-b border-ink">
          <tr>
            <th scope="col" className="py-1.5 pr-4 font-semibold">
              Field
            </th>
            <th scope="col" className="py-1.5 pr-4 font-semibold">
              Type
            </th>
            <th scope="col" className="py-1.5 font-semibold">
              Notes
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-rule">
          {rows.map((r) => (
            <tr key={r.name} className="align-top">
              <td className="py-2 pr-4 font-mono text-[0.8rem] break-words">{r.name}</td>
              <td className="py-2 pr-4 font-mono text-[0.8rem] break-words text-ink-soft">
                {r.type}
              </td>
              <td className="py-2">
                {r.required ? (
                  <span className="font-medium">Required.</span>
                ) : (
                  <span className="text-ink-soft">Optional.</span>
                )}{" "}
                {r.description}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
