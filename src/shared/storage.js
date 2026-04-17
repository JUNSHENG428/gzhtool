import { DEFAULT_SESSION, DEFAULT_SETTINGS, STORAGE_KEYS } from "./defaults.js";

export async function getSettings() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.settings);
  return { ...DEFAULT_SETTINGS, ...(stored[STORAGE_KEYS.settings] || {}) };
}

export async function saveSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ [STORAGE_KEYS.settings]: next });
  return next;
}

export async function getSession() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.session);
  return { ...DEFAULT_SESSION, ...(stored[STORAGE_KEYS.session] || {}) };
}

export async function saveSession(patch) {
  const next = { ...(await getSession()), ...patch };
  await chrome.storage.local.set({ [STORAGE_KEYS.session]: next });
  return next;
}
