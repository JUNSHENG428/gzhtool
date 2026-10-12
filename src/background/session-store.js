import { DEFAULT_SESSION, STORAGE_KEYS } from "../shared/defaults.js";

/** One writer in the service worker, shared by all extension pages. */
export function createSessionWriter(storageArea) {
  let tail = Promise.resolve();
  return function writeSession(patch) {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      return Promise.reject(new TypeError("会话更新必须是对象"));
    }
    // Freeze the caller's intent before it waits in the queue.
    const snapshot = structuredClone(patch);
    const write = tail.then(async () => {
      const stored = await storageArea.get(STORAGE_KEYS.session);
      const next = { ...DEFAULT_SESSION, ...(stored[STORAGE_KEYS.session] || {}), ...snapshot };
      await storageArea.set({ [STORAGE_KEYS.session]: next });
      return next;
    });
    // Reject the failed call, but allow subsequent writes to recover.
    tail = write.catch(() => {});
    return write;
  };
}

export function isTrustedSessionSender(sender, runtime) {
  return sender?.id === runtime.id &&
    typeof sender.url === "string" && sender.url.startsWith(runtime.getURL(""));
}
