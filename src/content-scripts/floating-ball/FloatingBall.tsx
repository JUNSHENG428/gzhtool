/**
 * 润笔 mp 编辑页悬浮助手 · React 5 球 strip
 *
 * 视觉规范（与砚台 v0.1.1 + v0.4.1 同源）：
 *   - 主球（拉草稿 / 砚）48px，墨绿底 + 暖米衬线字
 *   - 4 个次球（编/热/设/问）40px，暖米底 + 墨绿描边
 *   - 进场 stagger：translateX(-5px)→0 + opacity 0→1，250ms ease-out，50ms × index
 *   - hover 单球 scale(1.08) + 阴影上浮
 *   - 整组拖拽（仅纵向，松手位置写 settings.floatingBallPosition）
 *
 * 业务 wiring（与 vanilla strip 100% 等价）：
 *   - 主球（砚）click → PULL_DRAFT_TO_MP_EDITOR
 *     ├── 单草稿 → 直接 PULL（articleId 缺省）
 *     └── 多草稿 → 弹左侧 popover 选哪篇 → PULL with articleId
 *   - 编 → OPEN_EXTENSION_PAGE workspace.html
 *   - 热 → OPEN_EXTENSION_PAGE hot-topics.html
 *   - 设 → OPEN_EXTENSION_PAGE options.html
 *   - 问 → OPEN_EXTENSION_PAGE help.html
 *
 * Profile 状态点（主球右上角小圆）：
 *   - 绿（match）= 草稿目标公众号 与 mp 后台当前账号 模糊匹配上
 *   - 橙（mismatch）= 不匹配（accent 色，非红，与项目体系协调）
 *   - 灰（unknown）= 未关联 / 读不到 mp 当前账号 / 还没拉过草稿
 *
 * 主球 disabled 条件：
 *   - 当前页不是真正的 mp 编辑页（列表页/数据页等）
 *   - 或者 profile 不匹配（防写错号）
 *
 * 贴边隐藏（v0.1.1）：
 *   - settings.floatingBallEdgeTucked=true 时，整组 strip 平移 ~68px 出屏，仅留 12px peek
 *   - hover peek 自动展开；离开 1.5s 后自动贴回
 *   - 右键菜单切换；菜单打开期间不贴回
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { sendMessage } from "./lib/messaging";
import {
  getFloatingBallSettings,
  patchFloatingBallSettings,
  watchFloatingBallSettings,
  type FloatingBallSettings
} from "./lib/storage";
import { tokens } from "./lib/tokens";
import { ContextMenu } from "./ContextMenu";
import { DraftPickerPopover } from "./DraftPickerPopover";
import type {
  DraftItem,
  HelperResult,
  ProfileInfo,
  ProfileMatchState
} from "./types";

const STAGGER_MS = 50;
const ENTER_DURATION = 250;
const DRAG_THRESHOLD = 4;
const RIGHT_OFFSET = 20;
const BALL_GAP = 6;
const PRIMARY_SIZE = 48;
const SECONDARY_SIZE = 40;

// 贴边隐藏：露出 12px 让用户能 hover 唤醒
const EDGE_PEEK_PX = 12;
const TUCK_AUTO_DELAY_MS = 1500;
const TUCK_TRANSITION_MS = 280;

// 贴边平移距离：wrapper 宽度（48 + 12 padding） + 距右 20 - peek 12 ≈ 68
const TUCK_TRANSLATE_PX = PRIMARY_SIZE + 12 + RIGHT_OFFSET - EDGE_PEEK_PX;

type SwState = {
  drafts: DraftItem[];
  profile: ProfileInfo | null;
};

export function FloatingBall() {
  // ── settings 来源（vanilla 那边写、跨 tab 同步）──
  const [settings, setSettings] = useState<FloatingBallSettings | null>(null);
  // ── SW 推送的 STATE.payload（drafts / profile）——
  // 注意：v1 阶段我们只在拉草稿成功后才有 drafts/profile。
  // SW 暂时没有「主动推 payload 给浮球」的协议，这里先初始化空，
  // 拉草稿成功的回调里会更新。Phase 2.6 后再考虑加 PUSH_FLOATING_BALL_STATE 协议。
  const [swState, setSwState] = useState<SwState>({ drafts: [], profile: null });
  const [mpAccount, setMpAccount] = useState<string>("");
  const [mounted, setMounted] = useState(false);
  const [draftPickerOpen, setDraftPickerOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState({ x: 0, y: 0 });
  const [expanded, setExpanded] = useState(false); // 贴边态下 hover 唤醒标志

  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const dragStateRef = useRef<{
    startX: number;
    startY: number;
    startMouseX: number;
    startMouseY: number;
    moved: boolean;
  } | null>(null);
  const tuckCollapseTimerRef = useRef<number | null>(null);

  // ── 启动：读 settings + mp 账号 + 监听跨 tab 变化 ──
  useEffect(() => {
    let alive = true;
    getFloatingBallSettings().then((s) => {
      if (!alive) return;
      setSettings(s);
      setMpAccount(window.__runbi_mp_helper?.readCurrentMpAccountName?.() || "");
      requestAnimationFrame(() => alive && setMounted(true));
    });
    const stop = watchFloatingBallSettings((next) => {
      setSettings(next);
    });
    // mp 后台 DOM 可能延迟注入账号名，给一个轮询兜底（仅前 5s）
    let pollCount = 0;
    const poll = window.setInterval(() => {
      if (!alive) return;
      const name = window.__runbi_mp_helper?.readCurrentMpAccountName?.() || "";
      if (name && name !== mpAccount) setMpAccount(name);
      if (++pollCount >= 10) window.clearInterval(poll);
    }, 500);
    return () => {
      alive = false;
      stop();
      window.clearInterval(poll);
      if (tuckCollapseTimerRef.current != null) {
        window.clearTimeout(tuckCollapseTimerRef.current);
      }
    };
    // mpAccount 故意不进 deps：每 500ms 自取就行，进 deps 会无限重建 interval
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── 拖拽（仅纵向）──
  const onWrapperMouseDown = useCallback((event: React.MouseEvent) => {
    if (event.button !== 0) return;
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    const rect = wrapper.getBoundingClientRect();
    dragStateRef.current = {
      startX: rect.left,
      startY: rect.top,
      startMouseX: event.clientX,
      startMouseY: event.clientY,
      moved: false
    };

    const onMove = (e: MouseEvent) => {
      const ds = dragStateRef.current;
      if (!ds) return;
      const dy = e.clientY - ds.startMouseY;
      if (!ds.moved && Math.abs(dy) < DRAG_THRESHOLD) return;
      ds.moved = true;
      // 仅纵向移动（x 固定贴右）
      const nextY = clampY(ds.startY + dy, wrapper.offsetHeight);
      wrapper.style.top = `${nextY}px`;
    };

    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      const ds = dragStateRef.current;
      dragStateRef.current = null;
      if (ds?.moved && wrapper) {
        const rect2 = wrapper.getBoundingClientRect();
        // SW 写 settings.floatingBallPosition
        sendMessage("SAVE_FLOATING_BALL_POSITION", {
          x: rect2.right, // 右贴位置（保留兼容 vanilla 协议）
          y: rect2.top
        }).catch(() => {});
      }
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, []);

  // ── 右键菜单 ──
  const onContextMenu = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    setMenuPos({ x: event.clientX, y: event.clientY });
    setMenuOpen(true);
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const onAnyClick = () => setMenuOpen(false);
    const t = window.setTimeout(
      () => document.addEventListener("click", onAnyClick, { once: true }),
      0
    );
    return () => {
      window.clearTimeout(t);
      document.removeEventListener("click", onAnyClick);
    };
  }, [menuOpen]);

  // ── 贴边 hover 处理 ──
  const tucked = settings?.floatingBallEdgeTucked === true;

  const onWrapperMouseEnter = useCallback(() => {
    if (tuckCollapseTimerRef.current != null) {
      window.clearTimeout(tuckCollapseTimerRef.current);
      tuckCollapseTimerRef.current = null;
    }
    if (tucked) setExpanded(true);
  }, [tucked]);

  const onWrapperMouseLeave = useCallback(() => {
    if (!tucked) return;
    if (menuOpen) return; // 菜单打开期间不贴回
    if (tuckCollapseTimerRef.current != null) {
      window.clearTimeout(tuckCollapseTimerRef.current);
    }
    tuckCollapseTimerRef.current = window.setTimeout(() => {
      setExpanded(false);
      tuckCollapseTimerRef.current = null;
    }, TUCK_AUTO_DELAY_MS);
  }, [tucked, menuOpen]);

  // 菜单关闭后兜底贴回（与砚台 v0.1.1 同款）
  useEffect(() => {
    if (menuOpen) return;
    if (!tucked || !expanded) return;
    if (tuckCollapseTimerRef.current != null) {
      window.clearTimeout(tuckCollapseTimerRef.current);
    }
    tuckCollapseTimerRef.current = window.setTimeout(() => {
      setExpanded(false);
      tuckCollapseTimerRef.current = null;
    }, TUCK_AUTO_DELAY_MS);
    return () => {
      if (tuckCollapseTimerRef.current != null) {
        window.clearTimeout(tuckCollapseTimerRef.current);
        tuckCollapseTimerRef.current = null;
      }
    };
  }, [menuOpen, tucked, expanded]);

  // ── 拉草稿 ──
  const triggerPull = useCallback(async (articleId?: string) => {
    try {
      const reply = await sendMessage("PULL_DRAFT_TO_MP_EDITOR", articleId ? { articleId } : {});
      if (reply.ok) {
        // 更新 SW 推回来的 drafts/profile
        const payload = reply.payload || {};
        if (Array.isArray(payload.drafts)) {
          setSwState({
            drafts: payload.drafts as DraftItem[],
            profile: (payload.profile as ProfileInfo) || null
          });
        }
        showHelperDock({
          ok: true,
          level: "success",
          title: "已写入 mp 编辑器",
          message: "请按合规步骤手动保存草稿"
        });
      } else {
        showHelperDock({
          ok: false,
          level: "error",
          title: "拉草稿失败",
          message: reply.error || "未知错误",
          detail: reply.errorCode
        });
      }
    } catch (err) {
      showHelperDock({
        ok: false,
        level: "error",
        title: "扩展内部错误",
        message: (err as Error)?.message || String(err)
      });
    }
  }, []);

  const onPullClick = useCallback(() => {
    if (dragStateRef.current?.moved) return; // 拖拽尾巴的 click 拦掉
    if (swState.drafts.length > 1) {
      setDraftPickerOpen(true);
      return;
    }
    void triggerPull();
  }, [swState.drafts.length, triggerPull]);

  // ── 5 球定义 ──
  const profileMatch = computeProfileMatch(mpAccount, swState.profile?.targetProfileName);
  const isOnEditorPage = window.__runbi_mp_helper?.isEditorPage?.() ?? true;
  const pullDisabled = !isOnEditorPage || profileMatch === "mismatch";
  const pullTooltip = !isOnEditorPage
    ? "不在 mp 编辑页，无法写入"
    : profileMatch === "mismatch"
      ? `mp 后台账号「${mpAccount}」与草稿目标账号「${swState.profile?.targetProfileName}」不一致，已禁用以防写错号`
      : swState.drafts.length > 1
        ? `从润笔工作台取草稿（${swState.drafts.length} 篇可选）`
        : "从润笔工作台取当前激活草稿到 mp 编辑器";

  if (!settings) return null; // 还没读到 settings，不渲染（防闪烁）

  return (
    <>
      <div
        ref={wrapperRef}
        onMouseDown={onWrapperMouseDown}
        onContextMenu={onContextMenu}
        onMouseEnter={onWrapperMouseEnter}
        onMouseLeave={onWrapperMouseLeave}
        style={{
          position: "fixed",
          right: `${RIGHT_OFFSET}px`,
          top: computeInitialTop(settings.floatingBallPosition),
          zIndex: 2147483646,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: `${BALL_GAP}px`,
          padding: "6px",
          background: tokens.cream,
          border: `1px solid ${tokens.line}`,
          borderRadius: "28px",
          boxShadow: tokens.shadowMd,
          fontFamily: tokens.fontSans,
          userSelect: "none",
          cursor: tucked ? "pointer" : "grab",
          transform:
            tucked && !expanded ? `translateX(${TUCK_TRANSLATE_PX}px)` : "translateX(0)",
          transition: `transform ${TUCK_TRANSITION_MS}ms ${tokens.easeOut}`
        }}
      >
        <Ball
          primary
          label="砚"
          tooltip={pullTooltip}
          disabled={pullDisabled}
          mounted={mounted}
          index={0}
          onClick={onPullClick}
          dotColor={profileDotColor(profileMatch, swState.profile?.targetProfileName)}
          dotTitle={profileDotTitle(profileMatch, mpAccount, swState.profile?.targetProfileName)}
        />
        <Ball label="编" tooltip="打开润笔工作台" mounted={mounted} index={1}
          onClick={() =>
            void sendMessage("OPEN_EXTENSION_PAGE", { path: "src/workspace/workspace.html" })
          } />
        <Ball label="热" tooltip="热点抓题" mounted={mounted} index={2}
          onClick={() =>
            void sendMessage("OPEN_EXTENSION_PAGE", { path: "src/pages/hot-topics.html" })
          } />
        <Ball label="设" tooltip="打开设置" mounted={mounted} index={3}
          onClick={() =>
            void sendMessage("OPEN_EXTENSION_PAGE", { path: "src/options/options.html" })
          } />
        <Ball label="问" tooltip="帮助与教程" mounted={mounted} index={4}
          onClick={() =>
            void sendMessage("OPEN_EXTENSION_PAGE", { path: "src/pages/help.html" })
          } />
      </div>

      {draftPickerOpen && wrapperRef.current && (
        <DraftPickerPopover
          drafts={swState.drafts}
          anchorRect={wrapperRef.current.getBoundingClientRect()}
          onPick={(articleId) => {
            setDraftPickerOpen(false);
            void triggerPull(articleId);
          }}
          onClose={() => setDraftPickerOpen(false)}
        />
      )}

      {menuOpen && (
        <ContextMenu
          x={menuPos.x}
          y={menuPos.y}
          items={[
            {
              label: tucked ? "取消贴边隐藏" : "贴边隐藏",
              hint: tucked
                ? "让浮球完全可见"
                : "推到右边只露 12px，鼠标移过去再展开",
              onClick: async () => {
                await patchFloatingBallSettings({
                  floatingBallEdgeTucked: !tucked
                });
                setExpanded(false);
              }
            },
            {
              label: "永久隐藏浮球",
              hint: "可在设置页重新开启",
              onClick: async () => {
                await sendMessage("DISABLE_FLOATING_BALL", undefined);
              }
            },
            {
              label: "重置位置",
              hint: "回到默认右下角",
              onClick: async () => {
                await patchFloatingBallSettings({ floatingBallPosition: null });
              }
            },
            {
              label: "打开润笔工作台",
              hint: "等同点编球",
              onClick: async () => {
                await sendMessage("OPEN_EXTENSION_PAGE", {
                  path: "src/workspace/workspace.html"
                });
              }
            }
          ]}
          onClose={() => setMenuOpen(false)}
        />
      )}
    </>
  );
}

// ── 单球组件 ───────────────────────────────────────────

type BallProps = {
  primary?: boolean;
  label: string;
  tooltip: string;
  disabled?: boolean;
  mounted: boolean;
  index: number;
  onClick: () => void;
  dotColor?: string;
  dotTitle?: string;
};

function Ball(props: BallProps) {
  const isPrimary = !!props.primary;
  const size = isPrimary ? PRIMARY_SIZE : SECONDARY_SIZE;
  return (
    <button
      type="button"
      title={props.tooltip}
      aria-label={props.tooltip}
      disabled={props.disabled}
      onClick={(e) => {
        if (props.disabled) {
          e.preventDefault();
          return;
        }
        props.onClick();
      }}
      style={{
        width: `${size}px`,
        height: `${size}px`,
        borderRadius: "50%",
        background: isPrimary ? tokens.brand : tokens.surfaceElevated,
        border: `1px solid ${isPrimary ? tokens.brand : tokens.line}`,
        color: isPrimary ? tokens.cream : tokens.brand,
        fontFamily: tokens.fontSerif,
        fontWeight: 700,
        fontSize: isPrimary ? "20px" : "16px",
        lineHeight: 1,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: props.disabled ? "not-allowed" : "pointer",
        opacity: props.disabled ? 0.5 : props.mounted ? 1 : 0,
        padding: 0,
        outline: 0,
        position: "relative",
        boxShadow: isPrimary ? tokens.ballShadowPrimary : tokens.ballShadowSecondary,
        transition: `opacity ${ENTER_DURATION}ms ${tokens.easeOut}, transform ${ENTER_DURATION}ms ${tokens.easeOut}, box-shadow 220ms ${tokens.easeOut}, background 180ms ${tokens.easeOut}, border-color 180ms ${tokens.easeOut}, color 180ms ${tokens.easeOut}`,
        transform: props.mounted ? "translateX(0)" : "translateX(-5px)",
        transitionDelay: props.mounted ? `${props.index * STAGGER_MS}ms` : "0ms"
      }}
      onMouseEnter={(e) => {
        if (props.disabled) return;
        e.currentTarget.style.transform = "translateX(0) scale(1.08)";
        e.currentTarget.style.boxShadow = tokens.shadowLg;
      }}
      onMouseLeave={(e) => {
        if (props.disabled) return;
        e.currentTarget.style.transform = "translateX(0) scale(1)";
        e.currentTarget.style.boxShadow = isPrimary
          ? tokens.ballShadowPrimary
          : tokens.ballShadowSecondary;
      }}
    >
      {props.label}
      {props.dotColor && (
        <span
          title={props.dotTitle || ""}
          style={{
            position: "absolute",
            top: "1px",
            right: "1px",
            width: "10px",
            height: "10px",
            borderRadius: "50%",
            background: props.dotColor,
            border: `2px solid ${tokens.cream}`,
            boxShadow: "0 0 0 1px rgba(28,38,32,0.10)",
            pointerEvents: "none"
          }}
        />
      )}
    </button>
  );
}

// ── 工具函数 ───────────────────────────────────────────

function clampY(target: number, height: number): number {
  const top = 8;
  const bottom = window.innerHeight - height - 8;
  return Math.max(top, Math.min(bottom, target));
}

function computeInitialTop(position: { x: number; y: number } | null): string {
  if (position && Number.isFinite(position.y)) {
    return `${position.y}px`;
  }
  // 默认右下角偏上：viewport 中部偏下（与 vanilla strip 一致）
  return `${Math.max(120, Math.floor(window.innerHeight * 0.42))}px`;
}

function computeProfileMatch(
  mpAccount: string,
  targetProfileName: string | undefined
): ProfileMatchState {
  const target = String(targetProfileName || "").trim();
  if (!target) return "unknown";
  if (!mpAccount) return "unknown"; // 读不到 mp 账号 = fail-open
  if (target === mpAccount || target.includes(mpAccount) || mpAccount.includes(target)) {
    return "match";
  }
  return "mismatch";
}

function profileDotColor(state: ProfileMatchState, target?: string): string | undefined {
  if (!target && state === "unknown") return undefined; // 还没拉过草稿，不显点
  if (state === "match") return "#5fa56b"; // 和谐绿
  if (state === "mismatch") return tokens.accent; // 项目暖橙警示
  return tokens.softInk; // 灰
}

function profileDotTitle(
  state: ProfileMatchState,
  mpAccount: string,
  targetProfileName: string | undefined
): string {
  const target = String(targetProfileName || "").trim();
  if (state === "match") return `账号匹配：${mpAccount}`;
  if (state === "mismatch") {
    return `不匹配 · mp 当前是 ${mpAccount}，草稿目标是 ${target}`;
  }
  if (target) return `草稿目标：${target}（未读到 mp 当前账号，按理由放行）`;
  return "草稿未关联具体公众号";
}

function showHelperDock(result: HelperResult): void {
  window.__runbi_mp_helper?.renderHelperDock?.(result);
}
