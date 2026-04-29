/**
 * 润笔 mp 浮球 · 设计 token（TS 形态）
 *
 * 平移自 src/pages/design-tokens.css，保持视觉与润笔主体系一致：
 * - 墨绿主色 #173722
 * - 暖橙强调 #b8722e
 * - 暖纸底 #f7f5ef
 * - 衬线刊头（Noto Serif SC）+ 界面无衬线（DM Sans）
 *
 * 同步真理源：src/pages/design-tokens.css 是页面 CSS 那一侧。
 * 改色板时**两边都要改**，不要单边改 —— 这里给浮球 inline style 用，
 * 那边给页面/options/workspace 等 CSS utility 用。
 */
export const tokens = {
  // 中性墨色
  ink: "#1a2620",
  inkSecondary: "#3d4f45",
  softInk: "#5a6b62",
  muted: "#7a6f62",
  line: "#d4cfc3",
  lineStrong: "#c4bdb0",

  // 表面
  cream: "#f7f5ef",
  creamMuted: "#f6f4ee",
  surfaceElevated: "#fffdf8",

  // 主色
  brand: "#173722",
  brandHover: "#1f4a2e",
  brandSoft: "rgba(23,55,34,0.08)",

  // 强调（暖橙）
  accent: "#b8722e",
  accentSoft: "rgba(198,132,61,0.14)",
  onBrandWarm: "#f0d4b0",

  // 状态
  stateSuccess: "#2e7d4f",
  stateWarning: "#b87514",
  stateDanger: "#b94540",
  stateInfo: "#2d6f99",

  // 阴影
  shadowXs: "0 1px 2px rgba(28,38,32,0.04)",
  shadowSm: "0 4px 14px rgba(32,40,29,0.06)",
  shadowMd: "0 12px 32px rgba(32,40,29,0.08)",
  shadowLg: "0 20px 48px rgba(28,36,30,0.10)",

  // 球阴影（vanilla strip 同款）
  ballShadowPrimary:
    "0 6px 16px rgba(23,55,34,0.24),inset 0 1px 0 rgba(255,253,248,0.08)",
  ballShadowSecondary: "0 1px 2px rgba(28,38,32,0.04)",

  // 字体栈
  fontSans:
    '"DM Sans", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
  fontSerif:
    '"Noto Serif SC", "Source Han Serif SC", "Songti SC", "SimSun", serif',

  // 缓动
  easeOut: "cubic-bezier(0.22,1,0.36,1)",
  easeSpring: "cubic-bezier(0.34,1.56,0.64,1)",

  // 时长
  durationFast: "150ms",
  durationNormal: "220ms",
  durationSlow: "380ms",
} as const;

export type DesignTokens = typeof tokens;
