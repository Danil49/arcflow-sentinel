import Link from "next/link";

export default function NotFound() {
  return (
    <section className="pt-24">
      <h1 className="text-4xl font-extrabold tracking-tight">No trace here</h1>
      <p className="mt-4 max-w-[52ch] text-ink-soft">
        This link does not match a traced transfer. Paste the burn transaction on the search page to
        create one.
      </p>
      <Link
        href="/"
        className="mt-8 inline-block font-semibold text-accent underline underline-offset-4"
      >
        Search for a transfer
      </Link>
    </section>
  );
}
