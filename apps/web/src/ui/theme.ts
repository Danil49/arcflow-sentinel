export type ThemeChoice = "system" | "light" | "dark";
export const THEME_STORAGE_KEY = "sentinel-theme";

/**
 * Runs inline in <head> before first paint, so a stored choice never flashes the other theme.
 * Storage can throw (private mode, blocked site data): then the site simply follows the OS.
 */
export const THEME_BOOT_SCRIPT = `(function(){try{var t=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});if(t==="light"||t==="dark")document.documentElement.dataset.theme=t;}catch(e){}})();`;

export const nextTheme = (t: ThemeChoice): ThemeChoice =>
  t === "system" ? "light" : t === "light" ? "dark" : "system";
