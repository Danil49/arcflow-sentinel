import type { NextConfig } from "next";

const config: NextConfig = {
  // Workspace packages ship TypeScript sources (no build step).
  transpilePackages: [
    "@sentinel/core",
    "@sentinel/chains",
    "@sentinel/config",
    "@sentinel/contracts",
    "@sentinel/db",
    "@sentinel/worker",
  ],
  serverExternalPackages: ["pg"],
  poweredByHeader: false,
  // Linting runs repo-wide (`pnpm lint`); don't duplicate it inside `next build`.
  eslint: { ignoreDuringBuilds: true },
  webpack: (cfg) => {
    // Packages use NodeNext-style `./x.js` imports that point at `./x.ts` sources.
    cfg.resolve.extensionAlias = { ".js": [".ts", ".tsx", ".js"] };
    return cfg;
  },
};

export default config;
