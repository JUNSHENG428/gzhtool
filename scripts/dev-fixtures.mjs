#!/usr/bin/env node
/**
 * 开发期 fixtures 工具
 *
 * 功能：把"假状态"打印为浏览器控制台可粘贴的 JS 片段。
 * 使用方法：
 *   1. 加载未打包的扩展（chrome://extensions → 加载已解压的扩展）
 *   2. 选择需要的 fixture：
 *        node scripts/dev-fixtures.mjs as-pro
 *        node scripts/dev-fixtures.mjs reset
 *        node scripts/dev-fixtures.mjs all-fixtures
 *   3. 复制输出的代码片段
 *   4. 在扩展任一页面的 DevTools Console 里粘贴执行
 *
 * 不直接走 wrangler 把 license 打到服务器——本地 fixture 只为
 * 让 Pro 闸门 UI 在本机解锁，方便人测/机测，不影响真实付费校验。
 */

import { argv } from "node:process";

const PAID_FEATURE_KEYS = [
  "wechat.multiAccount",
  "scrape.drission",
  "ai.advancedTemplates",
  "ai.templateGenerator",
  "ai.unlimitedDaily",
  "wechat.publish",
  "hot.advancedSources",
  "ai.batchRewrite",
  "ai.deAiBoost"
];

const FIXTURES = {
  "as-pro": () => {
    const now = Date.now();
    const license = {
      key: "GZHT-DEV9-FAKE-PR99",
      plan: "pro",
      status: "active",
      expiresAt: now + 365 * 24 * 60 * 60 * 1000,
      features: Object.fromEntries(PAID_FEATURE_KEYS.map((k) => [k, true])),
      dailyQuota: -1,
      signedAt: now,
      signature: "dev-fake-signature",
      verifiedAt: now,
      activatedAt: new Date(now).toISOString(),
      user: { id: "dev-user", email: "dev@docuearn.com" }
    };
    const auth = {
      token: "dev-fake-token",
      user: { id: "dev-user", email: "dev@docuearn.com" },
      issuedAt: now
    };
    return {
      title: "🟢 注入 fake-Pro 状态（绕过 worker 验证）",
      payload: {
        wechatWriterLicense: license,
        wechatWriterLicenseAuth: auth
      }
    };
  },

  "reset": () => ({
    title: "🔴 重置：清掉所有授权 + 设置 + 用量 + 历史",
    raw: `chrome.storage.local.clear(() => {
  console.log("✓ 所有 chrome.storage.local 已清空，刷新页面查看新用户体验");
  setTimeout(() => location.reload(), 200);
});`
  }),

  "fake-source": () => ({
    title: "📥 注入一段假 source（模拟刚抓取完，可直接进编辑台测试）",
    payload: {
      wechatWriterSession: {
        currentSource: {
          title: "30 岁前学到的最重要的一课，是什么？",
          author: "沈砚之",
          url: "https://www.zhihu.com/question/123456/answer/987654",
          siteName: "知乎",
          contentMarkdown: [
            "很多人误以为长期主义是一种忍耐，其实它更像一种「放弃」——放弃你原本以为该立刻得到的东西，把它换成 5 年之后才发生的复利。",
            "我后来才明白，真正决定一个人能走多远的，是他每天放下了什么，而不是每天又新增了什么。",
            "在创业的第三年，我开始每个月强制做一次「减法清单」：写下我可以不做的事，再写下我必须停止做的事。神奇的是，那张清单上的东西，几乎全是别人眼里的「机会」。",
            "这是我 30 岁前学到的最重要的一课：分辨什么是机会，什么是诱惑。"
          ].join("\n\n"),
          fetchedAt: Date.now()
        }
      }
    }
  }),

  "fake-history": () => ({
    title: "📚 注入 5 篇假草稿历史（验证 dashboard 列表渲染）",
    payload: {
      wechatWriterDraftHistory: [
        sampleDraft("把这一篇知乎万赞答案改写成公众号长文：从对账到对人", -12 * 60_000),
        sampleDraft("X 上那条 700w 阅读的 AI agent 心智图，整理成一篇 3000 字", -2 * 60 * 60_000),
        sampleDraft("小红书 8 篇高赞家居 → 一篇杂志感长评测（Kinfolk 母版）", -22 * 60 * 60_000),
        sampleDraft("本月品牌叙事栏目 · 第 5 期初稿（New Yorker 母版）", -2 * 24 * 60 * 60_000),
        sampleDraft("热点：本周 AI 应用排行", -5 * 24 * 60 * 60_000)
      ]
    }
  }),

  "big-source": () => ({
    title: "📥 注入一段 10k 字超长 source（性能测试）",
    payload: {
      wechatWriterSession: {
        currentSource: {
          title: "性能测试 · 10k 字超长稿",
          author: "performance-test-bot",
          url: "https://example.com/perf-test",
          siteName: "性能测试",
          contentMarkdown: bigBody(),
          fetchedAt: Date.now()
        }
      }
    }
  })
};

function sampleDraft(title, delta) {
  const now = Date.now();
  return {
    id: `dev-${Math.random().toString(36).slice(2, 9)}`,
    title,
    siteName: "fixture",
    fetchedAt: now + delta,
    updatedAt: now + delta,
    sourceUrl: "https://example.com/draft",
    author: "fixture",
    contentMarkdown: "（fixture 草稿，仅用于 dashboard 列表渲染验证）",
    formattedHtml: ""
  };
}

function bigBody() {
  const para =
    "很多人误以为长期主义是一种忍耐，其实它更像一种放弃——放弃你原本以为该立刻得到的东西，把它换成 5 年之后才发生的复利。我后来才明白，真正决定一个人能走多远的，是他每天放下了什么，而不是每天又新增了什么。在创业的第三年，我开始每个月强制做一次减法清单：写下我可以不做的事，再写下我必须停止做的事。神奇的是，那张清单上的东西，几乎全是别人眼里的机会。";
  return Array.from({ length: 70 }, (_, i) => `## 第 ${i + 1} 节\n\n${para}\n\n${para}\n`).join("\n");
}

function emit(name) {
  const f = FIXTURES[name];
  if (!f) {
    console.error(`未知 fixture: ${name}`);
    console.error(`可选: ${Object.keys(FIXTURES).join(", ")}`);
    process.exit(1);
  }
  const out = f();
  console.log("");
  console.log("─".repeat(72));
  console.log(out.title);
  console.log("─".repeat(72));
  console.log("");
  if (out.raw) {
    console.log(out.raw);
  } else {
    const json = JSON.stringify(out.payload, null, 2);
    console.log(`chrome.storage.local.set(${json}, () => {
  console.log("✓ fixture 已注入：${name}");
  setTimeout(() => location.reload(), 200);
});`);
  }
  console.log("");
}

const target = argv[2] || "list";

if (target === "list") {
  console.log("");
  console.log("可用 fixtures（粘贴到扩展任一页面 DevTools Console 即可）：");
  console.log("");
  for (const [name, f] of Object.entries(FIXTURES)) {
    const meta = f();
    console.log(`  npm run dev:fixture -- ${name.padEnd(15)} ${meta.title.replace(/^[\W_]+/, "")}`);
  }
  console.log("");
} else if (target === "all") {
  for (const name of Object.keys(FIXTURES)) emit(name);
} else {
  emit(target);
}
