import type { ReactNode } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { IBM_Plex_Mono, Schibsted_Grotesk } from "next/font/google";
import { THEME_BOOT_SCRIPT } from "@/ui/theme";
import { ThemeToggle } from "@/ui/theme-toggle";
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
    // suppressHydrationWarning: the boot script may set data-theme before React hydrates.
    <html lang="en" className={`${grotesk.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body>
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:bg-sheet focus:px-3 focus:py-2"
        >
          Skip to content
        </a>
        <header className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 pt-6 sm:px-8">
          <Link href="/" className="text-lg font-bold tracking-tight">
            ArcFlow Sentinel
          </Link>
          {/* items-center, not baseline: the toggle is an inline-flex with an icon, whose baseline
              is the icon's bottom edge, which pushed it off the "API" text line. */}
          <nav className="flex items-center gap-5 text-sm leading-5 text-ink-soft">
            <Link href="/docs/api" className="hover:text-ink">
              API
            </Link>
            <ThemeToggle />
          </nav>
        </header>
        <main id="main" className="mx-auto max-w-6xl px-5 pb-20 sm:px-8">
          {children}
        </main>
        <footer className="mx-auto max-w-6xl px-5 sm:px-8">
          <div className="grid gap-3 border-t border-rule py-6 text-sm text-ink-soft sm:grid-cols-2 sm:gap-8">
            <p>
              Read-only monitor for CCTP V2 transfers between Arc and Base. It never holds your
              funds; the only transactions it sends anchor evidence hashes on Arc.
            </p>
            <p>
              Every evidence file this site produces is signed. Anyone can check a file against the{" "}
              <a
                href="/.well-known/sentinel-key.json"
                className="text-accent underline underline-offset-2"
              >
                public signing key
              </a>{" "}
              with the open-source verifier, so you don&apos;t have to trust this page.{" "}
              <Link
                href="/docs/api#verify-evidence"
                className="text-accent underline underline-offset-2"
              >
                How to verify
              </Link>
            </p>
          </div>
        </footer>
      </body>
    </html>
  );
}
