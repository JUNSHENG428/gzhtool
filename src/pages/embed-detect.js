/**
 * Embed 模式检测（共用小工具）
 *
 * 当独立页（hot-topics.html / 其它 src/pages/*.html）
 * 被 workspace.html 以 `?embed=1` 参数加载到 iframe 时，把
 * data-embed="1" 写到 <html> / <body>，触发 page.css 中的嵌入态样式
 * （隐藏 topbar / hero / skip-link，背景透明，收紧 padding）。
 *
 * MV3 不允许扩展页面内联 <script>，所以做成独立文件。
 * 必须在所有内容渲染前同步执行（放在 <head> 里，且 page.css 之后亦可），
 * 但为避免任何 CSS 闪屏，建议 <head> 中尽早 <script src> 引入。
 */
(function () {
  try {
    var p = new URLSearchParams(location.search);
    if (p.get("embed") !== "1") return;
    document.documentElement.setAttribute("data-embed", "1");
    if (document.body) {
      document.body.setAttribute("data-embed", "1");
    } else {
      document.addEventListener("DOMContentLoaded", function () {
        document.body.setAttribute("data-embed", "1");
      });
    }
  } catch (_) {
    // ignore — degraded gracefully to non-embed view
  }
})();
