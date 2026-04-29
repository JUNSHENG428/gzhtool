/**
 * 润笔 mp 浮球 · chrome.storage 读写包装
 *
 * 与砚台独立扩展不同的是：浮球状态不另起独立 key，全部存在 gzh 的
 * `wechatWriterSettings` 主对象里（与 vanilla strip 共享同一份 settings，
 * 切换 React/vanilla 实现时数据无需迁移）。
 *
 * 字段对照（src/shared/defaults.js）：
 *   - settings.floatingBallEnabled        boolean        是否显示浮球（vanilla/React 共用）
 *   - settings.floatingBallPosition       {x,y} | null   拖拽后位置（vanilla/React 共用）
 *   - settings.floatingBallEdgeTucked     boolean        是否贴边隐藏（NEW，React 专用，vanilla 暂不读）
 *   - settings.useReactFloatingBall       boolean        feature flag（v1=false，v2=true）
 */

const SETTINGS_KEY = "wechatWriterSettings";

export type FloatingBallSettings = {
  floatingBallEnabled: boolean;
  floatingBallPosition: { x: number; y: number } | null;
  floatingBallEdgeTucked: boolean;
  useReactFloatingBall: boolean;
};

/** 读取一份纯净的浮球相关 settings 切片（缺省字段走默认） */
export async function getFloatingBallSettings(): Promise<FloatingBallSettings> {
  const got = await chrome.storage.local.get(SETTINGS_KEY);
  const s = (got[SETTINGS_KEY] as Partial<FloatingBallSettings>) || {};
  return {
    floatingBallEnabled: Boolean(s.floatingBallEnabled),
    floatingBallPosition: isPosition(s.floatingBallPosition) ? s.floatingBallPosition : null,
    floatingBallEdgeTucked: Boolean(s.floatingBallEdgeTucked),
    useReactFloatingBall: Boolean(s.useReactFloatingBall),
  };
}

/**
 * 部分 patch settings —— 读出当前 settings 主对象，merge 新字段后写回。
 * 不能用 chrome.storage.local.set({ [SETTINGS_KEY]: { ...partial } })
 * 那样会**整个对象覆盖**丢掉其他业务字段（settings 里有几十个字段）。
 */
export async function patchFloatingBallSettings(
  partial: Partial<FloatingBallSettings>
): Promise<void> {
  const got = await chrome.storage.local.get(SETTINGS_KEY);
  const merged = { ...(got[SETTINGS_KEY] || {}), ...partial };
  await chrome.storage.local.set({ [SETTINGS_KEY]: merged });
}

function isPosition(value: unknown): value is { x: number; y: number } {
  return (
    !!value &&
    typeof value === "object" &&
    Number.isFinite((value as { x?: unknown }).x) &&
    Number.isFinite((value as { y?: unknown }).y)
  );
}

/**
 * 监听 settings 主对象变化（vanilla 那边写、options 页改、跨 tab 同步用）。
 * 返回 unsubscribe 函数。listener 收到的是**整个 settings 对象**而非 diff，
 * 由 React 端自己计算关注的字段是否变化。
 */
export function watchFloatingBallSettings(
  listener: (next: FloatingBallSettings, prev: FloatingBallSettings) => void
): () => void {
  const handler = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: chrome.storage.AreaName
  ) => {
    if (area !== "local") return;
    const change = changes[SETTINGS_KEY];
    if (!change) return;
    const next = normalize((change.newValue as Partial<FloatingBallSettings>) || {});
    const prev = normalize((change.oldValue as Partial<FloatingBallSettings>) || {});
    listener(next, prev);
  };
  chrome.storage.onChanged.addListener(handler);
  return () => chrome.storage.onChanged.removeListener(handler);
}

function normalize(s: Partial<FloatingBallSettings>): FloatingBallSettings {
  return {
    floatingBallEnabled: Boolean(s.floatingBallEnabled),
    floatingBallPosition: isPosition(s.floatingBallPosition) ? s.floatingBallPosition : null,
    floatingBallEdgeTucked: Boolean(s.floatingBallEdgeTucked),
    useReactFloatingBall: Boolean(s.useReactFloatingBall),
  };
}
