import type { ReactNode } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { IBM_Plex_Mono, Schibsted_Grotesk } from "next/font/google";
import "./globals.css";

const grotesk = Schibsted_Grotesk({
  subsets: ["latin"],
  variable: "--font-grotesk",
  display: "swap",
});
const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-plex-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: { default: "ArcFlow Sentinel", template: "%s · ArcFlow Sentinel" },
  description:
    "Follow a CCTP USDC transfer between Arc and Base, check it, and download signed evidence.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${grotesk.variable} ${mono.variable}`}>
      <body>
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:bg-sheet focus:px-3 focus:py-2"
        >
          Skip to content
        </a>
        <header className="mx-auto flex max-w-6xl items-baseline justify-between gap-4 px-5 pt-6 sm:px-8">
          <Link href="/" className="text-lg font-bold tracking-tight">
            ArcFlow Sentinel
          </Link>
          <nav className="flex gap-5 text-sm text-ink-soft">
            <a href="/api/openapi.json" className="hover:text-ink">
              API
            </a>
            <a href="/.well-known/sentinel-key.json" className="hover:text-ink">
              Signing key
            </a>
          </nav>
        </header>
        <main id="main" className="mx-auto max-w-6xl px-5 pb-20 sm:px-8">
          {children}
        </main>
        <footer className="mx-auto max-w-6xl px-5 sm:px-8">
          <p className="border-t border-rule py-6 text-sm text-ink-soft">
            Read-only monitor for CCTP V2 transfers between Arc and Base. It never holds your funds;
            the only transactions it sends anchor evidence hashes on Arc.
          </p>
        </footer>
      </body>
    </html>
  );
}
