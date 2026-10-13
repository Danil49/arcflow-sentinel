"use client";

import { useEffect, useState } from "react";
import { nextTheme, THEME_STORAGE_KEY, type ThemeChoice } from "./theme.js";

const LABEL: Record<ThemeChoice, string> = { system: "System", light: "Light", dark: "Dark" };

function readStored(): ThemeChoice {
  try {
    const t = localStorage.getItem(THEME_STORAGE_KEY);
    return t === "light" || t === "dark" ? t : "system";
  } catch {
    return "system";
  }
}

function apply(t: ThemeChoice) {
  const root = document.documentElement;
  if (t === "system") delete root.dataset.theme;
  else root.dataset.theme = t;
  try {
    if (t === "system") localStorage.removeItem(THEME_STORAGE_KEY);
    else localStorage.setItem(THEME_STORAGE_KEY, t);
  } catch {
    /* storage unavailable: the choice lasts for this page view */
  }
}

function Icon({ theme }: { theme: ThemeChoice }) {
  const common = {
    width: 16,
    height: 16,
    viewBox: "0 0 16 16",
    "aria-hidden": true,
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
  } as const;
  if (theme === "light") {
    return (
      <svg {...common}>
        <circle cx="8" cy="8" r="3" />
        <path
          d="M8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M3 3l1 1M12 12l1 1M3 13l1-1M12 4l1-1"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  if (theme === "dark") {
    return (
      <svg {...common}>
        <path d="M13.5 9.5A5.5 5.5 0 0 1 6.5 2.5a5.5 5.5 0 1 0 7 7Z" strokeLinejoin="round" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <rect x="1.75" y="2.75" width="12.5" height="8.5" rx="1" />
      <path d="M5.5 14h5M8 11.25V14" strokeLinecap="round" />
    </svg>
  );
}

/** Cycles System → Light → Dark. "System" follows the OS and stores nothing. */
export function ThemeToggle() {
  // Starts as "system" on the server; the real choice is read after mount (no hydration mismatch).
  const [theme, setTheme] = useState<ThemeChoice>("system");
  useEffect(() => setTheme(readStored()), []);

  return (
    <button
      type="button"
      onClick={() => {
        const t = nextTheme(theme);
        apply(t);
        setTheme(t);
      }}
      className="inline-flex items-center gap-1.5 rounded-sm text-ink-soft hover:text-ink"
      aria-label={`Theme: ${LABEL[theme]}. Switch to ${LABEL[nextTheme(theme)]}`}
      title={`Theme: ${LABEL[theme]}`}
    >
      <Icon theme={theme} />
      <span>{LABEL[theme]}</span>
    </button>
  );
}
