/**
 * dsh-session-tool 客户端半边（浏览器 bundle）。
 *
 * 入口（可用 profile 的 cordis.patch.yml 配置显隐/文案/顺序）：
 *   1. 会话头部工具栏 🗑      conversation.session.header.actions
 *   2. 侧栏行尾 ⋯ 菜单项      sidebar.workspaces.session.menu.item
 *   3. 侧栏行尾悬停 🗑        sidebar.workspaces.session.row.action
 *   4. 可选「打开回收站」菜单项（config.trash.menu）
 *
 * 与宿主的通信（全部同源 HTTP）：
 *   GET  /__dsh-session-tool/config     读取界面配置 + 回收站路径
 *   GET  /__dsh-session-tool/list       查询会话状态（运行中 / 是否还存在）
 *   POST /__dsh-session-tool/delete     执行删除（默认进回收目录）
 *   POST /__dsh-session-tool/open-trash 在文件管理器中打开回收站
 */
window.__ModuleLoader__.load({
  id: "dsh-session-tool",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const jsx = require("react/jsx-runtime").jsx;
    const jsxs = require("react/jsx-runtime").jsxs;
    const P = require("@deepseek-ai/dsh-client-ui-primitives");

    const DELETE_ENDPOINT = "/__dsh-session-tool/delete";
    const LIST_ENDPOINT = "/__dsh-session-tool/list";
    const CONFIG_ENDPOINT = "/__dsh-session-tool/config";
    const OPEN_ENDPOINT = "/__dsh-session-tool/open-trash";
    const ZH = String(navigator.language || navigator.userLanguage || "").toLowerCase().startsWith("zh");
    const T = ZH
      ? {
          menu: "删除会话", title: "删除会话", label: "会话", serial: "序列号", untitled: "未命名会话",
          desc: "该会话的日志会被移入回收目录（可手动恢复），并从侧栏消失。",
          warn: "会话正在运行", ack: "我已了解后果，确认删除", cancel: "取消", del: "删除", deleting: "删除中…",
          runningTitle: "该会话正在运行", runningDesc: "删除会立即停止它正在进行的任务，且无法恢复该任务的进度。",
          runningAck: "停止它并删除", stopDel: "停止并删除",
          notFoundDesc: "未能在会话列表中找到该会话（可能已被删除或列表尚未刷新），请刷新后重试。",
          doneTitle: "已删除", doneDesc: "文件已移到回收站，随时可以恢复（把批次文件夹搬回 sessions 目录即可）。",
          trashLabel: "回收站", openTrash: "打开回收站", finish: "完成",
          opened: "已在文件管理器中打开", openFail: "无法自动打开，请手动访问：",
          fail: (reason) => "删除失败：" + reason,
        }
      : {
          menu: "Delete session", title: "Delete session", label: "Session", serial: "Session id", untitled: "Untitled session",
          desc: "Its log moves to the trash directory (recoverable) and the sidebar row disappears.",
          warn: "This session is running", ack: "I understand the consequences", cancel: "Cancel", del: "Delete", deleting: "Deleting…",
          runningTitle: "This session is running", runningDesc: "Deleting stops its in-flight work immediately; that work cannot be resumed.",
          runningAck: "Stop it and delete", stopDel: "Stop and delete",
          notFoundDesc: "This session is not in the session list (it may already be deleted, or the list is stale). Refresh and try again.",
          doneTitle: "Deleted", doneDesc: "The files are in the trash directory and can be restored by moving the batch folder back.",
          trashLabel: "Trash", openTrash: "Open trash folder", finish: "Done",
          opened: "Opened in the file manager", openFail: "Could not open automatically, visit:",
          fail: (reason) => "Delete failed: " + reason,
        };

    /* 界面配置（宿主从 profile 的 cordis.patch.yml 读，默认值与此一致） */
    let CFG = {
      menu: { label: "", order: 500, hidden: false, danger: true, icon: true },
      rowAction: { order: 200, hidden: false },
      header: { order: 30, hidden: false },
      trash: { menu: true, label: "" },
    };
    let TRASH_DIR = "";

    const shortId = (id) => String(id || "").replace(/^session-/, "").slice(0, 8);

    const S = {
      meta: { color: "var(--dsw-alias-label-secondary, #8a8a8e)", fontSize: 13, lineHeight: "20px", margin: "0 0 10px", overflow: "hidden", textOverflow: "ellipsis" },
      warn: { color: "var(--dsw-alias-state-warn-primary, #f5a524)", fontSize: 13, lineHeight: "20px", margin: "0 0 10px" },
      opt: { display: "flex", alignItems: "center", gap: 8, fontSize: 13, lineHeight: "20px", color: "var(--dsw-alias-label-primary, inherit)", marginTop: 10 },
      status: { color: "var(--dsw-alias-state-success-primary, #059669)", fontSize: 12, lineHeight: "16px", marginTop: 8 },
      err: { color: "var(--dsw-alias-state-error-primary, #e5484d)", fontSize: 12, lineHeight: "16px", marginTop: 8 },
      head: { display: "flex", alignItems: "center", gap: 8, margin: "0 0 10px", fontSize: 14, fontWeight: 600 },
      cancelBtn: { padding: "6px 14px", borderRadius: 8, border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.4))", background: "transparent", color: "var(--dsw-alias-label-primary, inherit)", fontSize: 13, cursor: "pointer", marginRight: 8 },
      dangerBtn: { padding: "6px 14px", borderRadius: 8, border: "1px solid var(--dsw-alias-state-error-primary, #e5484d)", background: "var(--dsw-alias-state-error-primary, #e5484d)", color: "#fff", fontSize: 13, cursor: "pointer" },
      headerBtn: { display: "inline-flex", alignItems: "center", justifyContent: "center", width: 28, height: 28, padding: 0, border: "none", borderRadius: 6, background: "transparent", color: "var(--dsw-alias-label-tertiary, #8a8a8e)", cursor: "pointer", flex: "none" },
    };
    const dim = (style, off) => (off ? Object.assign({}, style, { opacity: 0.5, cursor: "default" }) : style);

    /* --------------------------- 弹窗状态（模块级） --------------------------- */
    let request = null;
    const listeners = new Set();
    function setRequest(next) {
      request = next;
      for (const listener of [...listeners]) listener();
    }
    function useRequest() {
      const [, bump] = React.useState(0);
      React.useEffect(() => {
        const listener = () => bump((n) => n + 1);
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      }, []);
      return request;
    }

    /* ------------------------ 当前会话（头部按钮用） ------------------------ */
    let workspaceService = null;
    function currentSessionId() {
      try {
        const ws = workspaceService;
        const snapshot = ws && ws.selection && typeof ws.selection.getSnapshot === "function" ? ws.selection.getSnapshot() : null;
        if (snapshot && snapshot.sessionId) return String(snapshot.sessionId);
        if (ws && ws.mainReference && ws.mainReference.sessionId) return String(ws.mainReference.sessionId);
      } catch { /* 忽略 */ }
      return null;
    }

    /* ------------------------------- 宿主请求 ------------------------------- */
    async function loadConfig() {
      try {
        const res = await fetch(CONFIG_ENDPOINT, { headers: { accept: "application/json" } });
        if (!res.ok) return;
        const data = await res.json();
        if (data && data.config) {
          const next = data.config;
          CFG = {
            menu: Object.assign({}, CFG.menu, next.menu || {}),
            rowAction: Object.assign({}, CFG.rowAction, next.rowAction || {}),
            header: Object.assign({}, CFG.header, next.header || {}),
            trash: Object.assign({}, CFG.trash, next.trash || {}),
          };
        }
        if (data && typeof data.trashDir === "string") TRASH_DIR = data.trashDir;
      } catch { /* 读不到就用默认配置 */ }
    }

    async function callDelete(sessionId, extra) {
      const res = await fetch(DELETE_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(Object.assign({ sessionIds: [sessionId] }, extra || {})),
      });
      let data = {};
      try { data = await res.json(); } catch { /* 空响应体 */ }
      return { status: res.status, data };
    }

    async function lookupSession(sessionId) {
      try {
        const res = await fetch(LIST_ENDPOINT, { headers: { accept: "application/json" } });
        if (!res.ok) return null;
        const data = await res.json();
        const sessions = data && data.ok && Array.isArray(data.sessions) ? data.sessions : [];
        const want = String(sessionId || "").replace(/^session-/, "");
        return sessions.find((item) => String(item.id).replace(/^session-/, "") === want) || null;
      } catch { return null; }
    }

    async function openTrashFolder(path) {
      try {
        const res = await fetch(OPEN_ENDPOINT, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: typeof path === "string" ? path : "" }),
        });
        const data = await res.json().catch(() => ({}));
        return data && data.ok === true;
      } catch { return false; }
    }

    /* ------------------------------- 确认弹窗 ------------------------------- */
    function DeleteSessionDialog() {
      const active = useRequest();
      const [ack, setAck] = React.useState(false);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState("");
      const [runningStep, setRunningStep] = React.useState(false);
      const [probe, setProbe] = React.useState(null);
      const [done, setDone] = React.useState(null);
      const [opening, setOpening] = React.useState(false);
      const [openState, setOpenState] = React.useState("");
      const key = active ? active.sessionId + "|" + String(active.title || "") : "";

      React.useEffect(() => {
        setAck(false); setBusy(false); setError(""); setRunningStep(false); setProbe(null);
        setDone(null); setOpening(false); setOpenState("");
        if (!active || !active.sessionId) return undefined;
        let cancelled = false;
        setProbe({ loading: true });
        lookupSession(active.sessionId).then((found) => {
          if (cancelled) return;
          if (found) {
            setProbe({ found: true, running: found.running === true, title: found.title || null });
            if (found.running === true) setRunningStep(true);
          } else {
            setProbe({ found: false });
          }
        });
        return () => { cancelled = true; };
      }, [key]);

      if (!active) return null;
      const notFound = probe !== null && probe.found === false;
      const running = runningStep === true;
      const name = active.title || (probe && probe.title) || T.untitled + " (" + shortId(active.sessionId) + ")";

      const close = () => { if (!busy) setRequest(null); };

      /* ---- 删除完成：应用内成功态（不再用原生 alert） ---- */
      if (done !== null) {
        const trashPath = done.trash || TRASH_DIR;
        const finish = () => setRequest(null);
        const doOpen = async () => {
          setOpening(true); setOpenState("");
          const ok = await openTrashFolder(trashPath);
          setOpenState(ok ? T.opened : T.openFail + trashPath);
          setOpening(false);
        };
        return jsx(P.Modal, {
          open: true,
          onClose: finish,
          title: T.doneTitle,
          closeLabel: T.finish,
          description: T.doneDesc,
          footer: [
            trashPath ? jsx(P.Button, { key: "open", disabled: opening, onClick: () => { void doOpen(); }, children: T.openTrash }) : null,
            jsx(P.Button, { key: "done", variant: "primary", onClick: finish, children: T.finish }),
          ].filter(Boolean),
          children: [
            jsxs("div", { key: "head", style: S.head, children: [
              jsx(P.IconCheckCircleFillRegular, { size: 16, style: { color: "var(--dsw-alias-state-success-primary, #059669)", flex: "none" } }),
              jsx("span", { children: name }),
            ] }),
            jsxs("div", { key: "meta", style: S.meta, children: [
              T.trashLabel + "：" + (trashPath || "—"),
            ] }),
            openState === "" ? null : jsx("div", { key: "open", style: openState === T.opened ? S.status : S.err, children: openState }),
          ].filter(Boolean),
        });
      }

      const description = notFound ? T.notFoundDesc : running ? T.runningDesc : T.desc;
      const blocked = busy || ack !== true || notFound;
      const confirm = async () => {
        setBusy(true); setError("");
        try {
          const out = await callDelete(active.sessionId, running ? { stop: true } : {});
          if (out.status === 409 && out.data && out.data.code === "running" && !running) {
            setRunningStep(true); setAck(false); setBusy(false); return;
          }
          if (out.status === 200 && out.data && out.data.ok) {
            setDone({ name, trash: out.data.trash || TRASH_DIR });
            setBusy(false);
            return;
          }
          const pick = (list) => (Array.isArray(list) && list.length > 0 ? String(list[0]) : "");
          setError((out.data && (out.data.error || pick(out.data.failed) || pick(out.data.refused))) || ("HTTP " + out.status));
        } catch (err) {
          setError(String(err && err.message ? err.message : err));
        }
        setBusy(false);
      };

      return jsx(P.Modal, {
        open: true,
        onClose: close,
        title: running ? T.runningTitle : T.title,
        closeLabel: T.cancel,
        description,
        footer: [
          jsx("button", {
            key: "cancel", type: "button", disabled: busy, onClick: close,
            style: dim(S.cancelBtn, busy), children: T.cancel,
          }),
          jsx("button", {
            key: "confirm", type: "button", disabled: blocked, onClick: () => { void confirm(); },
            style: dim(S.dangerBtn, blocked),
            children: busy ? T.deleting : (running ? T.stopDel : T.del),
          }),
        ],
        children: [
          jsxs("div", { key: "meta", style: S.meta, children: [
            T.label + "：" + name,
            jsx("br", {}),
            T.serial + "：" + String(active.sessionId),
          ] }),
          running ? jsxs("div", { key: "warn", style: S.warn, children: [jsx(P.IconWarningTriangleOutlineRegular, { size: 13, style: { verticalAlign: "-2px", marginRight: 6 } }), T.warn] }) : null,
          notFound ? null : jsx("div", { key: "ack", style: S.opt, children: jsx(P.Checkbox, {
            checked: ack === true,
            disabled: busy,
            onChange: (next) => setAck(next === true),
            label: running ? T.runningAck : T.ack,
          }) }),
          busy ? jsx("div", { key: "busy", style: S.status, children: T.deleting }) : null,
          error !== "" ? jsx("div", { key: "err", style: S.err, role: "alert", children: error }) : null,
        ].filter(Boolean),
      });
    }

    /* ------------------------------- 各入口组件 ------------------------------- */
    function openDialog(sessionId, displayTitle) {
      if (!sessionId) return;
      setRequest({ sessionId, title: displayTitle });
    }

    function DeleteSessionMenuItem(props) {
      let closeMenu = () => {};
      if (typeof props.useMenuOpenState === "function") {
        try {
          const pair = props.useMenuOpenState();
          if (pair && typeof pair[1] === "function") closeMenu = () => pair[1](false);
        } catch { /* 忽略 */ }
      }
      return jsx(P.MenuItemButton, {
        danger: CFG.menu.danger !== false,
        icon: CFG.menu.icon === false ? undefined : jsx(P.IconTrashOutlineRegular, { size: 14 }),
        onSelect: () => { closeMenu(); openDialog(props.sessionId, props.displayTitle); },
        children: CFG.menu.label || T.menu,
      });
    }

    function OpenTrashMenuItem() {
      return jsx(P.MenuItemButton, {
        icon: jsx(P.IconFolderOpenOutlineRegular, { size: 14 }),
        onSelect: () => { void openTrashFolder(TRASH_DIR); },
        children: CFG.trash.label || T.openTrash,
      });
    }

    function DeleteSessionRowButton(props) {
      return jsx(P.Tooltip, {
        label: CFG.menu.label || T.menu, side: "bottom", align: "end", delayMs: 500,
        children: jsx("button", {
          type: "button", "aria-label": CFG.menu.label || T.menu, style: S.headerBtn,
          onClick: (event) => {
            if (event && typeof event.stopPropagation === "function") event.stopPropagation();
            openDialog(props.sessionId, props.displayTitle);
          },
          children: jsx(P.IconTrashOutlineRegular, { size: 14 }),
        }),
      });
    }

    function DeleteSessionHeaderButton() {
      const sessionId = currentSessionId();
      if (!sessionId) return null;
      return jsx(P.Tooltip, {
        label: CFG.menu.label || T.menu, side: "bottom", align: "end", delayMs: 500,
        children: jsx("button", {
          type: "button", "aria-label": CFG.menu.label || T.menu, style: S.headerBtn,
          onClick: () => openDialog(sessionId, null),
          children: jsx(P.IconTrashOutlineRegular, { size: 16 }),
        }),
      });
    }

    async function apply(ctx) {
      // slots 服务由 @deepseek-ai/dsh-client-ui-renderer 提供；已在 inject 里声明等待就绪
      if (!ctx.slots || typeof ctx.slots.register !== "function") return;

      if (typeof ctx.get === "function") workspaceService = ctx.get("uiWorkspace");
      if (!workspaceService && typeof ctx.inject === "function") {
        try { ctx.inject(["uiWorkspace"], (sub) => { workspaceService = sub.uiWorkspace || (sub.get && sub.get("uiWorkspace")); }); } catch { /* 忽略 */ }
      }

      await loadConfig();

      if (CFG.menu.hidden !== true) {
        ctx.slots.inject("sidebar.workspaces.session.menu.item", function* () {
          yield ctx.slots.register({ name: "sidebar.workspaces.session.menu.item", id: "dsh-session-tool.delete", order: CFG.menu.order }, DeleteSessionMenuItem);
        });
      }
      if (CFG.trash.menu !== false) {
        ctx.slots.inject("sidebar.workspaces.session.menu.item", function* () {
          yield ctx.slots.register({ name: "sidebar.workspaces.session.menu.item", id: "dsh-session-tool.trash", order: CFG.menu.order + 1 }, OpenTrashMenuItem);
        });
      }
      if (CFG.rowAction.hidden !== true) {
        ctx.slots.inject("sidebar.workspaces.session.row.action", function* () {
          yield ctx.slots.register({ name: "sidebar.workspaces.session.row.action", id: "dsh-session-tool.delete", order: CFG.rowAction.order }, DeleteSessionRowButton);
        });
      }
      if (CFG.header.hidden !== true) {
        ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({ name: "conversation.session.header.actions", id: "dsh-session-tool.header", order: CFG.header.order }, DeleteSessionHeaderButton));
      }
      ctx.slots.inject("shell.overlay", () => ctx.slots.register({ name: "shell.overlay", id: "dsh-session-tool.dialog", order: 500 }, DeleteSessionDialog));
    }

    exports.apply = apply;
    exports.inject = ["slots"];
    return module.exports;
  },
});
