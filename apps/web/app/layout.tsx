import type { ReactNode } from "react";

export const metadata = {
  title: "ArcFlow Sentinel",
  description: "Reliability monitor for CCTP V2 USDC transfers between Arc and Base",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
