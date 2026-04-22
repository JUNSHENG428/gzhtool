// Shared theme bootstrap utility.
// Reads "workspace-theme-preference" from localStorage, falls back to OS preference,
// and applies data-theme="dark"|"light" to <html>.

export const THEME_STORAGE_KEY = "workspace-theme-preference";

export function applyThemePreferenceFromStorage() {
  try {
    const preference = localStorage.getItem(THEME_STORAGE_KEY) || "auto";
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const isDark = preference === "dark" || (preference === "auto" && prefersDark);
    document.documentElement.setAttribute("data-theme", isDark ? "dark" : "light");
    return isDark ? "dark" : "light";
  } catch {
    return "light";
  }
}

export function getThemePreference() {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY) || "auto";
  } catch {
    return "auto";
  }
}

export function setThemePreference(preference) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // ignore
  }
}
