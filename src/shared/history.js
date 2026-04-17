import { STORAGE_KEYS } from "./defaults.js";
import { createId, normalizeText } from "./utils.js";

const HISTORY_LIMIT = 20;
const HISTORY_FALLBACK_LIMIT = 10;

function cloneValue(value, fallback = null) {
  try {
    return JSON.parse(JSON.stringify(value ?? fallback));
  } catch {
    return fallback;
  }
}

function buildSourcePreview(source) {
  const blocks = Array.isArray(source?.blocks) ? source.blocks : [];
  const images = Array.isArray(source?.images) ? source.images : [];
  const excerpt = normalizeText(
    blocks
      .filter((block) => block?.type !== "image")
      .map((block) => String(block?.text || ""))
      .join(" ")
  ).slice(0, 180);

  return {
    title: String(source?.title || "").trim(),
    url: String(source?.url || "").trim(),
    description: String(source?.description || "").trim(),
    wordCount: Number(source?.wordCount || 0),
    imageCount: images.length,
    blockCount: blocks.length,
    excerpt
  };
}

function normalizeHistoryEntry(entry) {
  if (!entry || typeof entry !== "object") {
    return null;
  }

  const source = cloneValue(entry.source, null);
  const sourcePreview =
    entry.sourcePreview && typeof entry.sourcePreview === "object"
      ? {
          title: String(entry.sourcePreview.title || "").trim(),
          url: String(entry.sourcePreview.url || "").trim(),
          description: String(entry.sourcePreview.description || "").trim(),
          wordCount: Number(entry.sourcePreview.wordCount || 0),
          imageCount: Number(entry.sourcePreview.imageCount || 0),
          blockCount: Number(entry.sourcePreview.blockCount || 0),
          excerpt: normalizeText(entry.sourcePreview.excerpt || "").slice(0, 180)
        }
      : buildSourcePreview(source);

  return {
    id: String(entry.id || createId("draft-history")),
    label: String(entry.label || "草稿记录").trim() || "草稿记录",
    createdAt: String(entry.createdAt || new Date().toISOString()),
    articleBundle: Array.isArray(entry.articleBundle) ? cloneValue(entry.articleBundle, []) : [],
    sourcePreview,
    source,
    currentArticleIndex: Math.max(0, Number(entry.currentArticleIndex || 0) || 0),
    selectedImageIndex: Math.max(0, Number(entry.selectedImageIndex || 0) || 0),
    theme: String(entry.theme || "").trim()
  };
}

async function readHistoryEntries() {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.draftHistory);
    const entries = stored[STORAGE_KEYS.draftHistory];
    if (!Array.isArray(entries)) {
      return [];
    }
    return entries.map((entry) => normalizeHistoryEntry(entry)).filter(Boolean);
  } catch {
    return [];
  }
}

async function writeHistoryEntries(entries) {
  const normalizedEntries = entries
    .map((entry) => normalizeHistoryEntry(entry))
    .filter(Boolean)
    .slice(0, HISTORY_LIMIT);

  try {
    await chrome.storage.local.set({ [STORAGE_KEYS.draftHistory]: normalizedEntries });
    return normalizedEntries;
  } catch {
    const fallbackEntries = normalizedEntries.slice(0, HISTORY_FALLBACK_LIMIT);
    try {
      await chrome.storage.local.set({ [STORAGE_KEYS.draftHistory]: fallbackEntries });
      return fallbackEntries;
    } catch {
      return fallbackEntries;
    }
  }
}

export async function saveSnapshot(label, articleBundle, source, extras = {}) {
  try {
    const historyEntries = await readHistoryEntries();
    const entry = normalizeHistoryEntry({
      id: createId("draft-history"),
      label,
      createdAt: new Date().toISOString(),
      articleBundle: cloneValue(articleBundle, []),
      sourcePreview: buildSourcePreview(source),
      source: cloneValue(source, null),
      currentArticleIndex: extras.currentArticleIndex,
      selectedImageIndex: extras.selectedImageIndex,
      theme: extras.theme
    });

    await writeHistoryEntries([entry, ...historyEntries]);
    return entry;
  } catch {
    return null;
  }
}

export async function listSnapshots() {
  return readHistoryEntries();
}

export async function loadSnapshot(id) {
  try {
    const historyEntries = await readHistoryEntries();
    return historyEntries.find((entry) => entry.id === id) || null;
  } catch {
    return null;
  }
}

export async function deleteSnapshot(id) {
  try {
    const historyEntries = await readHistoryEntries();
    const nextEntries = historyEntries.filter((entry) => entry.id !== id);
    if (nextEntries.length === historyEntries.length) {
      return false;
    }
    await writeHistoryEntries(nextEntries);
    return true;
  } catch {
    return false;
  }
}

export async function clearHistory() {
  try {
    await chrome.storage.local.set({ [STORAGE_KEYS.draftHistory]: [] });
    return true;
  } catch {
    return false;
  }
}
