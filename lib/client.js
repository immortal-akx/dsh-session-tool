/**
 * dsh-session-tool 客户端半边（浏览器 bundle）。
 *
 * 三个入口，共用一个确认弹窗：
 *   1. 会话头部工具栏的 🗑 按钮（conversation.session.header.actions）
 *   2. 侧栏会话行 "..." 菜单项（sidebar.workspaces.session.menu.item）
 *   3. 侧栏会话行悬停按钮（sidebar.workspaces.session.row.action）
 *
 * 弹窗挂在 shell.overlay（根级浮层），打开时先向宿主查询会话状态：
 *   GET  /__dsh-session-tool/list    → 拿到标题 / 是否运行中 / 是否还存在
 *   POST /__dsh-session-tool/delete  → 执行删除（默认进回收目录）
 *
 * inject 里写的是【服务名】：等 renderer 的 slots 服务就绪后再 apply。
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
    const ZH = String(navigator.language || navigator.userLanguage || "").toLowerCase().startsWith("zh");
    const T = ZH
      ? {
          menu: "删除会话",
          title: "删除会话",
          label: "会话",
          serial: "序列号",
          untitled: "未命名会话",
          desc: "该会话的日志会被移入回收目录（可手动恢复），并从侧栏消失。",
          warn: "⚠ 会话正在运行",
          ack: "我已了解后果，确认删除",
          cancel: "取消",
          del: "删除",
          deleting: "删除中…",
          runningTitle: "该会话正在运行",
          runningDesc: "删除会立即停止它正在进行的任务，且无法恢复该任务的进度。",
          runningAck: "停止它并删除",
          stopDel: "停止并删除",
          notFoundDesc: "未能在会话列表中找到该会话（可能已被删除或列表尚未刷新），请刷新后重试。",
          done: (name) => "已删除「" + name + "」。（文件在回收目录，可恢复）",
          fail: (reason) => "删除失败：" + reason,
        }
      : {
          menu: "Delete session",
          title: "Delete session",
          label: "Session",
          serial: "Session id",
          untitled: "Untitled session",
          desc: "Its log moves to the trash directory (recoverable) and the sidebar row disappears.",
          warn: "⚠ This session is running",
          ack: "I understand the consequences",
          cancel: "Cancel",
          del: "Delete",
          deleting: "Deleting…",
          runningTitle: "This session is running",
          runningDesc: "Deleting stops its in-flight work immediately; that work cannot be resumed.",
          runningAck: "Stop it and delete",
          stopDel: "Stop and delete",
          notFoundDesc: "This session is not in the session list (it may already be deleted, or the list is stale). Refresh and try again.",
          done: (name) => 'Deleted "' + name + '". (The log is in the trash directory and can be restored.)',
          fail: (reason) => "Delete failed: " + reason,
        };

    const shortId = (id) => String(id || "").replace(/^session-/, "").slice(0, 8);

    /* 样式：全部用 DSH 主题变量，明暗主题都跟随 */
    const S = {
      meta: { color: "var(--dsw-alias-label-secondary, #8a8a8e)", fontSize: 13, lineHeight: "20px", margin: "0 0 10px", overflow: "hidden", textOverflow: "ellipsis" },
      warn: { color: "var(--dsw-alias-state-warn-primary, #f5a524)", fontSize: 13, lineHeight: "20px", margin: "0 0 10px" },
      opt: { display: "flex", alignItems: "center", gap: 8, fontSize: 13, lineHeight: "20px", color: "var(--dsw-alias-label-primary, inherit)", marginTop: 10 },
      status: { color: "var(--dsw-alias-label-secondary, #8a8a8e)", fontSize: 12, lineHeight: "16px", marginTop: 8 },
      err: { color: "var(--dsw-alias-state-error-primary, #e5484d)", fontSize: 12, lineHeight: "16px", marginTop: 8 },
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

    /* ------------------------------- 确认弹窗 ------------------------------- */
    function DeleteSessionDialog() {
      const active = useRequest();
      const [ack, setAck] = React.useState(false);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState("");
      const [runningStep, setRunningStep] = React.useState(false);
      const [probe, setProbe] = React.useState(null);
      const key = active ? active.sessionId + "|" + String(active.title || "") : "";

      React.useEffect(() => {
        setAck(false); setBusy(false); setError(""); setRunningStep(false); setProbe(null);
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
      const description = notFound ? T.notFoundDesc : running ? T.runningDesc : T.desc;
      const blocked = busy || ack !== true || notFound;

      const close = () => { if (!busy) setRequest(null); };
      const confirm = async () => {
        setBusy(true); setError("");
        try {
          let out = await callDelete(active.sessionId, running ? { stop: true } : {});
          if (out.status === 409 && out.data && out.data.code === "running" && !running) {
            setRunningStep(true); setAck(false); setBusy(false); return;
          }
          if (out.status === 200 && out.data && out.data.ok) {
            setRequest(null);
            window.alert(T.done(name));
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
            key: "cancel",
            type: "button",
            disabled: busy,
            onClick: close,
            style: dim(S.cancelBtn, busy),
            children: T.cancel,
          }),
          jsx("button", {
            key: "confirm",
            type: "button",
            disabled: blocked,
            onClick: () => { void confirm(); },
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
          running ? jsx("div", { key: "warn", style: S.warn, children: T.warn }) : null,
          notFound ? null : jsx("div", { key: "ack", style: S.opt, children: jsx(P.Checkbox, {
            checked: ack === true,
            disabled: busy,
            onChange: (next) => setAck(next === true),
            label: running ? T.runningAck : T.ack,
          }) }),
          busy ? jsx("div", { key: "busy", style: S.status, children: T.deleting }) : null,
          error !== "" ? jsx("div", { key: "err", style: S.err, role: "alert", children: error }) : null,
        ],
      });
    }

    /* ------------------------------- 三个入口 ------------------------------- */
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
        } catch { /* 宿主没给这个 hook 就退化成不关菜单 */ }
      }
      return jsx(P.MenuItemButton, {
        danger: true,
        icon: jsx(P.IconTrashOutlineRegular, { size: 14 }),
        onSelect: () => { closeMenu(); openDialog(props.sessionId, props.displayTitle); },
        children: T.menu,
      });
    }

    function DeleteSessionRowButton(props) {
      return jsx(P.Tooltip, {
        label: T.menu, side: "bottom", align: "end", delayMs: 500,
        children: jsx("button", {
          type: "button",
          "aria-label": T.menu,
          style: S.headerBtn,
          onClick: (event) => {
            if (event && typeof event.stopPropagation === "function") event.stopPropagation();
            openDialog(props.sessionId, props.displayTitle);
          },
          children: jsx(P.IconTrashOutlineRegular, { size: 14 }),
        }),
      });
    }

    /** 会话头部工具栏：对"当前正在看的会话"下手。 */
    function DeleteSessionHeaderButton() {
      const sessionId = currentSessionId();
      if (!sessionId) return null;
      return jsx(P.Tooltip, {
        label: T.menu, side: "bottom", align: "end", delayMs: 500,
        children: jsx("button", {
          type: "button",
          "aria-label": T.menu,
          style: S.headerBtn,
          onClick: () => openDialog(sessionId, null),
          children: jsx(P.IconTrashOutlineRegular, { size: 16 }),
        }),
      });
    }

    function apply(ctx) {
      // slots 服务由 @deepseek-ai/dsh-client-ui-renderer 提供；已在 inject 里声明等待就绪
      if (!ctx.slots || typeof ctx.slots.register !== "function") return;

      // 当前会话由工作区插件持有（持久化 store: dsh.sessions.current）
      if (typeof ctx.get === "function") workspaceService = ctx.get("uiWorkspace");
      if (!workspaceService && typeof ctx.inject === "function") {
        try { ctx.inject(["uiWorkspace"], (sub) => { workspaceService = sub.uiWorkspace || (sub.get && sub.get("uiWorkspace")); }); } catch { /* 忽略 */ }
      }

      ctx.slots.inject("sidebar.workspaces.session.menu.item", function* () {
        yield ctx.slots.register({
          name: "sidebar.workspaces.session.menu.item",
          id: "dsh-session-tool.delete",
          order: 500,
        }, DeleteSessionMenuItem);
      });
      ctx.slots.inject("sidebar.workspaces.session.row.action", function* () {
        yield ctx.slots.register({
          name: "sidebar.workspaces.session.row.action",
          id: "dsh-session-tool.delete",
          order: 200,
        }, DeleteSessionRowButton);
      });
      ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
        name: "conversation.session.header.actions",
        id: "dsh-session-tool.header",
        order: 30,
      }, DeleteSessionHeaderButton));
      ctx.slots.inject("shell.overlay", () => ctx.slots.register({
        name: "shell.overlay",
        id: "dsh-session-tool.dialog",
        order: 500,
      }, DeleteSessionDialog));
    }

    exports.apply = apply;
    exports.inject = ["slots"];
    return module.exports;
  },
});
