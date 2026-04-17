/**
 * 全局快捷键与 ⌘K 命令面板
 */

const isMac =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || "");

function formatShortcut(parts) {
  if (isMac) {
    return parts
      .map((p) => {
        if (p === "Mod") return "⌘";
        if (p === "Shift") return "⇧";
        if (p === "Enter") return "↵";
        return p;
      })
      .join("");
  }
  return parts.map((p) => (p === "Mod" ? "Ctrl" : p)).join("+");
}

/**
 * @param {{
 *   schedulePersist: () => void;
 *   setStatus: (msg: string, type?: string) => void;
 *   captureSource: () => void | Promise<void>;
 *   rewriteArticle: () => void | Promise<void>;
 *   copyHtml: () => void | Promise<void>;
 *   copyMarkdown: () => void | Promise<void>;
 *   downloadHtml: () => void;
 *   downloadMarkdown: () => void;
 *   toggleOutputPreviewTab: () => void;
 *   cycleEditorTheme: () => void;
 *   openHelp: () => void;
 *   openSettings: () => void;
 *   openWorkspaceHistory: () => void | Promise<void>;
 *   closeOverlays: () => void;
 *   blurEditor?: () => void;
 *   moveCurrentArticle?: (direction: number) => void;
 *   onCommandPaletteOpenChange?: (open: boolean) => void;
 * }} api
 */
export function initWorkspaceShortcuts(api) {
  let commandPaletteOpen = false;
  let filterText = "";
  let selectedIndex = 0;

  const backdrop = document.createElement("div");
  backdrop.id = "commandPaletteBackdrop";
  backdrop.className = "command-palette-backdrop";
  backdrop.setAttribute("hidden", "");
  backdrop.setAttribute("aria-hidden", "true");

  const dialog = document.createElement("div");
  dialog.className = "command-palette panel";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");

  const title = document.createElement("h2");
  title.id = "commandPaletteTitle";
  title.className = "sr-only";
  title.textContent = "命令面板";
  dialog.setAttribute("aria-labelledby", title.id);

  const search = document.createElement("input");
  search.type = "search";
  search.className = "command-palette-search";
  search.placeholder = "搜索命令…";
  search.setAttribute("autocomplete", "off");
  search.setAttribute("spellcheck", "false");
  search.setAttribute("aria-label", "搜索命令");

  const listEl = document.createElement("ul");
  listEl.id = "commandPaletteList";
  listEl.className = "command-palette-list";
  search.setAttribute("aria-controls", listEl.id);

  dialog.append(title, search, listEl);
  backdrop.append(dialog);
  document.body.append(backdrop);

  function openCommandPalette() {
    commandPaletteOpen = true;
    filterText = "";
    selectedIndex = 0;
    search.value = "";
    backdrop.removeAttribute("hidden");
    backdrop.setAttribute("aria-hidden", "false");
    renderList();
    requestAnimationFrame(() => {
      search.focus();
      search.select();
    });
    api.onCommandPaletteOpenChange?.(true);
  }

  function closeCommandPalette() {
    if (!commandPaletteOpen) return;
    commandPaletteOpen = false;
    backdrop.setAttribute("hidden", "");
    backdrop.setAttribute("aria-hidden", "true");
    api.onCommandPaletteOpenChange?.(false);
  }

  function getCommands() {
    const Mod = "Mod";
    return [
      {
        id: "commandPalette",
        label: "命令面板",
        shortcut: formatShortcut([Mod, "K"]),
        searchText: "命令 面板 搜索",
        run: () => openCommandPalette()
      },
      {
        id: "capture",
        label: "抓取网页",
        shortcut: formatShortcut([Mod, "Shift", "C"]),
        searchText: "抓取网页 来源 采集 zhuawangye zwy",
        run: () => void api.captureSource()
      },
      {
        id: "rewrite",
        label: "AI 改写当前篇",
        shortcut: formatShortcut([Mod, "Enter"]),
        searchText: "改写 ai rewrite gaixie",
        run: () => void api.rewriteArticle()
      },
      {
        id: "save",
        label: "保存草稿",
        shortcut: formatShortcut([Mod, "S"]),
        searchText: "保存 草稿 save baocun",
        run: () => {
          api.schedulePersist();
          api.setStatus("已保存", "success");
        }
      },
      {
        id: "exportHtml",
        label: "导出 HTML",
        shortcut: "",
        searchText: "导出 html 预览 daochu",
        run: () => api.downloadHtml()
      },
      {
        id: "exportMd",
        label: "导出 Markdown",
        shortcut: "",
        searchText: "导出 markdown md",
        run: () => api.downloadMarkdown()
      },
      {
        id: "togglePreview",
        label: "切换预览模式（HTML / Markdown）",
        shortcut: "",
        searchText: "切换 预览 html markdown yulan",
        run: () => api.toggleOutputPreviewTab()
      },
      {
        id: "help",
        label: "打开帮助",
        shortcut: "",
        searchText: "帮助 help bangzhu",
        run: () => api.openHelp()
      },
      {
        id: "settings",
        label: "打开设置",
        shortcut: "",
        searchText: "设置 shezhi options",
        run: () => api.openSettings()
      },
      {
        id: "history",
        label: "查看历史",
        shortcut: "",
        searchText: "历史 草稿 版本 lishi",
        run: () => void api.openWorkspaceHistory()
      },
      {
        id: "theme",
        label: "切换排版主题",
        shortcut: "",
        searchText: "主题 排版 切换 theme zhuti",
        run: () => api.cycleEditorTheme()
      }
    ];
  }

  function getFilteredCommands() {
    const q = filterText.trim().toLowerCase();
    const all = getCommands();
    if (!q) return all;
    return all.filter((cmd) => {
      const hay = `${cmd.label} ${cmd.searchText}`.toLowerCase();
      return hay.includes(q);
    });
  }

  function renderList() {
    const cmds = getFilteredCommands();
    if (selectedIndex >= cmds.length) {
      selectedIndex = Math.max(0, cmds.length - 1);
    }
    listEl.innerHTML = cmds
      .map((cmd, i) => {
        const active = i === selectedIndex ? " is-active" : "";
        const hint = cmd.shortcut
          ? `<kbd class="command-palette-kbd">${escapeHtml(cmd.shortcut)}</kbd>`
          : "";
        return `<li>
          <button type="button" class="command-palette-item${active}" data-cmd-id="${escapeAttr(
            cmd.id
          )}">
            <span class="command-palette-label">${escapeHtml(cmd.label)}</span>
            ${hint}
          </button>
        </li>`;
      })
      .join("");

    listEl.querySelectorAll("button[data-cmd-id]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-cmd-id");
        const cmd = getFilteredCommands().find((c) => c.id === id);
        if (cmd) {
          runCommand(cmd);
        }
      });
    });
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function escapeAttr(s) {
    return escapeHtml(s).replace(/'/g, "&#39;");
  }

  function runCommand(cmd) {
    closeCommandPalette();
    try {
      cmd.run();
    } catch (_) {}
  }

  function toggleCommandPalette() {
    if (commandPaletteOpen) {
      closeCommandPalette();
    } else {
      openCommandPalette();
    }
  }

  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) {
      closeCommandPalette();
    }
  });

  search.addEventListener("input", () => {
    filterText = search.value;
    selectedIndex = 0;
    renderList();
  });

  search.addEventListener("keydown", (e) => {
    const cmds = getFilteredCommands();
    if (e.key === "ArrowDown") {
      e.preventDefault();
      selectedIndex = Math.min(selectedIndex + 1, Math.max(0, cmds.length - 1));
      renderList();
      scrollActiveIntoView();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      selectedIndex = Math.max(selectedIndex - 1, 0);
      renderList();
      scrollActiveIntoView();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const cmd = cmds[selectedIndex];
      if (cmd) runCommand(cmd);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeCommandPalette();
    }
  });

  function scrollActiveIntoView() {
    const active = listEl.querySelector(".command-palette-item.is-active");
    active?.scrollIntoView({ block: "nearest" });
  }

  function handleKeydown(event) {
    const metaOrCtrl = event.metaKey || event.ctrlKey;

    if (metaOrCtrl && event.key.toLowerCase() === "k") {
      event.preventDefault();
      event.stopPropagation();
      toggleCommandPalette();
      return;
    }

    if (event.key === "Escape" && commandPaletteOpen) {
      event.preventDefault();
      closeCommandPalette();
      return;
    }

    if (commandPaletteOpen) {
      return;
    }

    if (metaOrCtrl && event.key.toLowerCase() === "s") {
      event.preventDefault();
      api.schedulePersist();
      api.setStatus("已保存", "success");
      return;
    }

    if (metaOrCtrl && event.key === "Enter") {
      event.preventDefault();
      void api.rewriteArticle();
      return;
    }

    if (metaOrCtrl && event.shiftKey && event.key.toLowerCase() === "c") {
      event.preventDefault();
      void api.captureSource();
      return;
    }

    if (event.altKey && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
      if (event.key === "ArrowUp") {
        event.preventDefault();
        api.moveCurrentArticle?.(-1);
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        api.moveCurrentArticle?.(1);
        return;
      }
    }

    if (metaOrCtrl) {
      switch (event.key) {
        case "z":
          event.preventDefault();
          if (event.shiftKey) {
            document.execCommand("redo", false);
          } else {
            document.execCommand("undo", false);
          }
          return;
        case "y":
          event.preventDefault();
          document.execCommand("redo", false);
          return;
        default:
          break;
      }
    }

    if (event.key === "Escape") {
      api.closeOverlays();
      api.blurEditor?.();
    }
  }

  document.addEventListener("keydown", handleKeydown, true);

  return {
    openCommandPalette,
    closeCommandPalette,
    isCommandPaletteOpen: () => commandPaletteOpen
  };
}
