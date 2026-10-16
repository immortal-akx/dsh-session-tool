/**
 * dsh-session-tool 客户端半边（浏览器 bundle）。
 *
 * 三处界面：
 *   1. 侧栏会话行 "..." 菜单项「删除会话」   sidebar.workspaces.session.menu.item
 *   2. 对话区头部工具栏的「重命名会话」✏️     conversation.session.header.actions（order -40）
 *   3. 根级弹窗（删除确认 / 重命名输入）        shell.overlay
 *
 * 与宿主通信（同源 HTTP）：
 *   GET  /__dsh-session-tool/config   → 界面配置
 *   GET  /__dsh-session-tool/list     → 会话清单（标题 / 运行状态 / 是否存在）
 *   POST /__dsh-session-tool/delete   → 永久删除（运行中的先停止）
 *
 * 重命名直接走官方客户端服务：sessions.using(...) → reference.binding.session.rename(title)
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
    const DIAG_PATH = "/__dsh-session-tool/diag";
    const ZH = String(navigator.language || navigator.userLanguage || "").toLowerCase().startsWith("zh");
    const T = ZH
      ? {
          menu: "删除会话", title: "删除会话", label: "会话", serial: "序列号", untitled: "未命名会话",
          desc: "删除后，该对话将不可恢复",
          warn: "会话正在运行 —— 删除会立即中断它正在进行的任务",
          ack: "我已了解后果，确认删除", runningAck: "停止它并删除",
          cancel: "取消", del: "删除", stopDel: "停止并删除", deleting: "删除中…",
          notFoundDesc: "未能在会话列表中找到该会话（可能已被删除或列表尚未刷新），请刷新后重试。",
          doneTitle: "已删除", doneDesc: "该对话已永久删除，无法恢复。", finish: "完成",
          fail: (reason) => "删除失败：" + reason,
          rename: "重命名会话", renameDesc: "给这个会话起个新名字（回车可提交）",
          renamePlaceholder: "输入新的会话名称", confirm: "确定", renaming: "保存中…",
          renameFailed: (reason) => "重命名失败：" + reason,
          renameUnavailable: "当前环境不支持重命名（sessions 服务不可用）",
          renameEmpty: "名称不能为空",
        }
      : {
          menu: "Delete session", title: "Delete session", label: "Session", serial: "Session id", untitled: "Untitled session",
          desc: "This conversation cannot be recovered after deletion",
          warn: "This session is running — deleting it will interrupt its in-flight work",
          ack: "I understand the consequences", runningAck: "Stop it and delete",
          cancel: "Cancel", del: "Delete", stopDel: "Stop and delete", deleting: "Deleting…",
          notFoundDesc: "This session is not in the session list (it may already be deleted, or the list is stale). Refresh and try again.",
          doneTitle: "Deleted", doneDesc: "This conversation has been permanently deleted and cannot be recovered.", finish: "Done",
          fail: (reason) => "Delete failed: " + reason,
          rename: "Rename session", renameDesc: "Give this session a new name (Enter submits)",
          renamePlaceholder: "Enter a new session name", confirm: "OK", renaming: "Saving…",
          renameFailed: (reason) => "Rename failed: " + reason,
          renameUnavailable: "Renaming is unavailable here (the sessions service is missing)",
          renameEmpty: "The name cannot be empty",
        };

    /** 界面配置（宿主归一化后通过 GET /config 提供）。 */
    let CFG = {
      menu: { label: "", order: 500, hidden: false, danger: true, disabled: false },
      shippedRows: { pin: {}, rename: {}, fork: {}, archive: {} },
      shippedButtons: { archive: {}, pin: {} },
    };

    const shortId = (id) => String(id || "").replace(/^session-/, "").slice(0, 8);

    const S = {
      meta: { color: "var(--dsw-alias-label-secondary, #8a8a8e)", fontSize: 13, lineHeight: "20px", margin: "0 0 10px", overflow: "hidden", textOverflow: "ellipsis" },
      warn: { color: "var(--dsw-alias-state-warn-primary, #f5a524)", fontSize: 13, lineHeight: "20px", margin: "0 0 10px" },
      opt: { display: "flex", alignItems: "center", gap: 8, fontSize: 13, lineHeight: "20px", color: "var(--dsw-alias-label-primary, inherit)", marginTop: 10 },
      status: { color: "var(--dsw-alias-label-secondary, #8a8a8e)", fontSize: 12, lineHeight: "16px", marginTop: 8 },
      err: { color: "var(--dsw-alias-state-error-primary, #e5484d)", fontSize: 12, lineHeight: "16px", marginTop: 8 },
      head: { display: "flex", alignItems: "center", gap: 8, margin: "0 0 10px", fontSize: 14, fontWeight: 600 },
      cancelBtn: { padding: "6px 14px", borderRadius: 8, border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.4))", background: "transparent", color: "var(--dsw-alias-label-primary, inherit)", fontSize: 13, cursor: "pointer", marginRight: 8 },
      dangerBtn: { padding: "6px 14px", borderRadius: 8, border: "1px solid var(--dsw-alias-state-error-primary, #e5484d)", background: "var(--dsw-alias-state-error-primary, #e5484d)", color: "#fff", fontSize: 13, cursor: "pointer" },
      primaryBtn: { padding: "6px 14px", borderRadius: 8, border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.4))", background: "var(--dsw-alias-bg-elevated, rgba(128,128,128,.12))", color: "var(--dsw-alias-label-primary, inherit)", fontSize: 13, cursor: "pointer" },
      titleBtn: { display: "inline-flex", alignItems: "center", justifyContent: "center", width: 28, height: 28, padding: 0, border: "none", borderRadius: 5, background: "transparent", color: "var(--dsw-alias-label-tertiary, #8a8a8e)", cursor: "pointer", flex: "none", verticalAlign: "-3px", marginLeft: 6 },
    };
    const dim = (style, off) => (off ? Object.assign({}, style, { opacity: 0.5, cursor: "default" }) : style);

    /** 原生按钮（弹窗底部）：与官方 Button 视觉一致的极简实现 */
    function plainButton(key, label, primary, disabled, onClick) {
      const base = primary ? S.primaryBtn : S.cancelBtn;
      return jsx("button", {
        key, type: "button", disabled, onClick,
        style: Object.assign({}, dim(base, disabled), primary ? { marginRight: 0 } : {}),
        children: label,
      });
    }

    /* --------------------------- 两个弹窗的状态 --------------------------- */
    let request = null;          // 删除：{ sessionId, title }
    let renameReq = null;        // 重命名：{ sessionId, title }
    const listeners = new Set();
    function emit() { for (const listener of [...listeners]) listener(); }
    function setRequest(next) { request = next; emit(); }
    function setRename(next) { renameReq = next; emit(); }
    function useStore() {
      const [, bump] = React.useState(0);
      React.useEffect(() => {
        const listener = () => bump((n) => n + 1);
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      }, []);
      return { request, renameReq };
    }

    /* ------------------------------- 服务句柄 ------------------------------- */
    let ctxRef = null;             // apply 时记下的上下文（服务惰性取用）
    let workspaceService = null;   // 官方行接管用的状态来源
    let sessionsService = null;    // 重命名用的官方服务

    // 服务惰性解析：不用 ctx.inject（否则服务晚到会让入口一直停在 loading）
    function serviceOf(name) {
      try { return ctxRef && typeof ctxRef.get === "function" ? ctxRef.get(name) : undefined } catch { return undefined; }
    }
    function workspace() {
      if (!workspaceService) workspaceService = serviceOf("uiWorkspace");
      return workspaceService;
    }
    function sessions() {
      if (!sessionsService) sessionsService = serviceOf("sessions");
      return sessionsService;
    }

    /* ------------------------------- 宿主请求 ------------------------------- */
    /** 诊断上报：把界面侧发生的事写进宿主日志（失败也不影响任何功能）。 */
    async function diag(lines, level) {
      try {
        await fetch(DIAG_PATH, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ level: level || "info", lines: Array.isArray(lines) ? lines : [String(lines)] }),
          signal: AbortSignal.timeout(3000),
        });
      } catch { /* 诊断失败忽略 */ }
    }

    /**
     * 读取界面配置。返回 { changed, note }：note 记录这次读取的结果（用于诊断）。
     */
    async function loadConfig() {
      try {
        const res = await fetch(CONFIG_ENDPOINT, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(3000) });
        if (!res.ok) return { changed: false, note: "http " + res.status };
        const data = await res.json();
        const next = data && data.config;
        if (!next) return { changed: false, note: "no config in body" };
        const merged = {
          menu: Object.assign({}, CFG.menu, next.menu || {}),
          shippedRows: Object.assign({}, CFG.shippedRows, next.shippedRows || {}),
          shippedButtons: Object.assign({}, CFG.shippedButtons, next.shippedButtons || {}),
        };
        const changed = JSON.stringify(merged) !== JSON.stringify(CFG);
        CFG = merged;
        return { changed, note: "ok" };
      } catch (error) {
        return { changed: false, note: "failed: " + String(error && error.message ? error.message : error) };
      }
    }

    async function callDelete(sessionId) {
      const res = await fetch(DELETE_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionIds: [sessionId] }),
        signal: AbortSignal.timeout(60000),
      });
      let data = {};
      try { data = await res.json(); } catch { /* 空响应体 */ }
      return { status: res.status, data };
    }

    async function lookupSession(sessionId) {
      try {
        const res = await fetch(LIST_ENDPOINT, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(5000) });
        if (!res.ok) return null;
        const data = await res.json();
        const sessions = data && data.ok && Array.isArray(data.sessions) ? data.sessions : [];
        const want = String(sessionId || "").replace(/^session-/, "");
        return sessions.find((item) => String(item.id).replace(/^session-/, "") === want) || null;
      } catch { return null; }
    }

    /** 重命名：走官方客户端服务（与官方重命名菜单项完全相同的调用）。 */
    async function renameSession(sessionId, title) {
      const svc = sessions();
      if (!svc || typeof svc.using !== "function") throw new Error(T.renameUnavailable);
      const result = await svc.using(sessionId, { source: "workspaceOperation" }, (reference) => reference.binding.session.rename(title));
      if (!result || result.ok !== true) {
        const detail = result && result.error && result.error.message ? result.error.message : "";
        throw new Error(detail || T.renameFailed("?"));
      }
      return true;
    }

    /* ------------------------------- 删除弹窗 ------------------------------- */
    function DeleteSessionDialog() {
      const { request: active } = useStore();
      const [ack, setAck] = React.useState(false);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState("");
      const [probe, setProbe] = React.useState(null);
      const [done, setDone] = React.useState(null);
      const key = active ? active.sessionId + "|" + String(active.title || "") : "";

      React.useEffect(() => {
        setAck(false); setBusy(false); setError(""); setProbe(null); setDone(null);
        if (!active || !active.sessionId) return undefined;
        let cancelled = false;
        setProbe({ loading: true });
        lookupSession(active.sessionId).then((found) => {
          if (cancelled) return;
          setProbe(found ? { found: true, running: found.running === true, title: found.title || null } : { found: false });
        });
        return () => { cancelled = true; };
      }, [key]);

      if (!active) return null;
      const notFound = probe !== null && probe.found === false;
      const running = probe !== null && probe.found === true && probe.running === true;
      const name = active.title || (probe && probe.title) || T.untitled + " (" + shortId(active.sessionId) + ")";
      const close = () => { if (!busy) setRequest(null); };

      if (done !== null) {
        const finish = () => setRequest(null);
        return jsx(P.Modal, {
          open: true, onClose: finish, title: T.doneTitle, closeLabel: T.finish, description: T.doneDesc,
          footer: [plainButton("done", T.finish, true, false, finish)],
          children: jsxs("div", { key: "head", style: S.head, children: [
            jsx(P.IconCheckCircleFillRegular, { size: 16, style: { color: "var(--dsw-alias-state-success-primary, #059669)", flex: "none" } }),
            jsx("span", { children: done.name }),
          ] }),
        });
      }

      const blocked = busy || ack !== true || notFound;
      const confirm = async () => {
        setBusy(true); setError("");
        try {
          const out = await callDelete(active.sessionId);
          if (out.status === 200 && out.data && out.data.ok) { setDone({ name }); setBusy(false); return; }
          const pick = (list) => (Array.isArray(list) && list.length > 0 ? String(list[0]) : "");
          setError((out.data && (out.data.error || pick(out.data.failed) || pick(out.data.refused))) || ("HTTP " + out.status));
        } catch (err) {
          setError(String(err && err.message ? err.message : err));
        }
        setBusy(false);
      };

      return jsx(P.Modal, {
        open: true, onClose: close, title: T.title, closeLabel: T.cancel,
        description: notFound ? T.notFoundDesc : T.desc,
        footer: [
          plainButton("cancel", T.cancel, false, busy, close),
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
          running ? jsxs("div", { key: "warn", style: S.warn, children: [
            jsx(P.IconWarningTriangleOutlineRegular, { size: 13, style: { verticalAlign: "-2px", marginRight: 6 } }),
            T.warn,
          ] }) : null,
          notFound ? null : jsx("div", { key: "ack", style: S.opt, children: jsx(P.Checkbox, {
            checked: ack === true, disabled: busy,
            onChange: (next) => setAck(next === true),
            label: running ? T.runningAck : T.ack,
          }) }),
          busy ? jsx("div", { key: "busy", style: S.status, children: T.deleting }) : null,
          error !== "" ? jsx("div", { key: "err", style: S.err, role: "alert", children: T.fail(error) }) : null,
        ].filter(Boolean),
      });
    }

    /* ------------------------------ 重命名弹窗 ------------------------------ */
    function RenameSessionDialog() {
      const { renameReq: active } = useStore();
      const [draft, setDraft] = React.useState("");
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState("");
      const key = active ? active.sessionId : "";

      React.useEffect(() => {
        setDraft(active ? String(active.title || "") : "");
        setBusy(false); setError("");
      }, [key]);

      if (!active) return null;
      const trimmed = draft.trim();
      const blocked = busy || trimmed === "";
      const close = () => { if (!busy) setRename(null); };
      const confirm = async () => {
        if (blocked) return;
        setBusy(true); setError("");
        try {
          await renameSession(active.sessionId, trimmed);
          setRename(null);
        } catch (err) {
          setError(String(err && err.message ? err.message : err));
        }
        setBusy(false);
      };

      return jsx(P.Modal, {
        open: true, onClose: close, title: T.rename, closeLabel: T.cancel, description: T.renameDesc,
        footer: [
          plainButton("cancel", T.cancel, false, busy, close),
          jsx("button", {
            key: "confirm", type: "button", disabled: blocked, onClick: () => { void confirm(); },
            style: dim(S.primaryBtn, blocked),
            children: busy ? T.renaming : T.confirm,
          }),
        ],
        children: [
          jsx("div", { key: "input", style: { marginBottom: 10 }, children: jsx(P.Input, {
            value: draft,
            autoFocus: true,
            spellCheck: false,
            placeholder: T.renamePlaceholder,
            disabled: busy,
            onChange: (event) => setDraft(event.target.value),
            onKeyDown: (event) => {
              if (event.key === "Enter") { event.preventDefault(); void confirm(); }
              if (event.key === "Escape") { event.preventDefault(); close(); }
            },
          }) }),
          busy ? jsx("div", { key: "busy", style: S.status, children: T.renaming }) : null,
          error !== "" ? jsx("div", { key: "err", style: S.err, role: "alert", children: error }) : null,
        ].filter(Boolean),
      });
    }

    /* ------------------------------ 头部 ✏️ 按钮 ------------------------------ */
    /**
     * 会话名后面的重命名按钮。该插槽在「当前会话面包屑」上是 {标题}{插槽}；
     * 在其它面包屑（父会话/子代理）上是"替换标题"语义，所以我们只在当前会话渲染。
     */
    /** 当前会话 id（工作区服务的持久化选择）。 */
    function currentSessionId() {
      try {
        const ws = workspace();
        const snapshot = ws && ws.selection && typeof ws.selection.getSnapshot === "function" ? ws.selection.getSnapshot() : null;
        if (snapshot && snapshot.sessionId) return String(snapshot.sessionId);
        if (ws && ws.mainReference && ws.mainReference.sessionId) return String(ws.mainReference.sessionId);
      } catch { /* 忽略 */ }
      return null;
    }

    /**
     * 会话头部工具栏里的「重命名会话」按钮。
     * 放在官方 conversation.session.header.actions 插槽里（order -40 = 该队列最左，尽量贴近标题），
     * 不与任何官方占位者抢同一个 cell，也不依赖插槽 owner props。
     */
    function RenameSessionButton(props) {
      const owner = props || {};
      const sessionId = currentSessionId();
      if (!sessionId) return null;
      let title = "";
      try {
        const summary = typeof owner.useSessions === "function" ? owner.useSessions((state) => state.byId[sessionId]) : null;
        if (summary && summary.blank === true) return null;   // 空白会话不显示
        title = (summary && (summary.displayTitle || summary.title)) || "";
      } catch { /* 拿不到会话快照就照常显示 */ }
      return jsx(P.Tooltip, {
        label: T.rename, side: "bottom", align: "end", delayMs: 500,
        children: jsx("button", {
          type: "button",
          "aria-label": T.rename,
          style: S.titleBtn,
          onClick: (event) => {
            if (event && typeof event.stopPropagation === "function") event.stopPropagation();
            setRename({ sessionId, title });
          },
          children: jsx(P.IconEditOutlineRegular, { size: 14 }),
        }),
      });
    }

    /* ---------------------------- ⋯ 菜单：删除项 ---------------------------- */
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
        disabled: CFG.menu.disabled === true,
        icon: jsx(P.IconTrashOutlineRegular, { size: 14 }),
        onSelect: () => { closeMenu(); openDialog(props.sessionId, props.displayTitle); },
        children: CFG.menu.label || T.menu,
      });
    }

    /* ------------------- 接管官方菜单行（改名 / 改序 / 隐藏） ------------------- */
    const MENU_SLOT = "sidebar.workspaces.session.menu.item";
    const SHIPPED_ORDER = { pin: 100, rename: 200, fork: 300, archive: 400 };
    const ROW_SLOT = "sidebar.workspaces.session.row.action";
    const SHIPPED_BUTTON_ORDER = { archive: 100, pin: 200 };

    function ShippedHidden() { return null; }

    function menuCloser(props) {
      if (typeof props.useMenuOpenState === "function") {
        try {
          const pair = props.useMenuOpenState();
          if (pair && typeof pair[1] === "function") return () => pair[1](false);
        } catch { /* 忽略 */ }
      }
      return () => {};
    }

    const sameId = (a, b) => String(a || "").replace(/^session-/, "") === String(b || "").replace(/^session-/, "");
    function shippedState(props, sessionId) {
      let snapshot = null;
      try { if (typeof props.useWorkspaces === "function") snapshot = props.useWorkspaces((s) => s); } catch { /* 忽略 */ }
      if (!snapshot) {
        try { snapshot = workspaceService && workspaceService.workspaces && workspaceService.workspaces.list ? workspaceService.workspaces.list.getSnapshot() : null } catch { /* 忽略 */ }
      }
      const has = (key) => Array.isArray(snapshot && snapshot[key]) && snapshot[key].some((x) => sameId(x, sessionId));
      return { pinned: has("pinnedSessionIds"), archived: has("archivedSessionIds") };
    }

    function callWorkspace(method, sessionId) {
      try {
        const ws = workspace();
        if (!ws || typeof ws[method] !== "function") return;
        const result = ws[method](sessionId);
        if (result && typeof result.catch === "function") result.catch(() => {});
      } catch { /* 忽略 */ }
    }

    function ShippedPinRow(props) {
      const cfg = CFG.shippedRows.pin || {};
      const sessionId = props.sessionId;
      const state = shippedState(props, sessionId);
      if (state.archived) return null;
      const close = menuCloser(props);
      return jsx(P.MenuItemButton, {
        icon: jsx(state.pinned ? P.IconPinFillRegular : P.IconPinOutlineRegular, {}),
        onSelect: () => { close(); callWorkspace(state.pinned ? "unpinSession" : "pinSession", sessionId); },
        children: state.pinned ? (cfg.activeLabel || "取消置顶") : (cfg.label || "置顶会话"),
      });
    }

    function ShippedArchiveRow(props) {
      const cfg = CFG.shippedRows.archive || {};
      const sessionId = props.sessionId;
      const state = shippedState(props, sessionId);
      const close = menuCloser(props);
      return jsx(P.MenuItemButton, {
        icon: jsx(state.archived ? P.IconUnarchiveOutlineRegular : P.IconArchiveOutlineRegular, { size: 14 }),
        onSelect: () => { close(); callWorkspace(state.archived ? "unarchiveSession" : "archiveSession", sessionId); },
        children: state.archived ? (cfg.activeLabel || "取消归档") : (cfg.label || "归档会话"),
      });
    }

    function ShippedForkRow(props) {
      const cfg = CFG.shippedRows.fork || {};
      const close = menuCloser(props);
      return jsx(P.MenuItemButton, {
        icon: jsx(P.IconBranchOutlineRegular, {}),
        onSelect: () => { close(); callWorkspace("forkSession", props.sessionId); },
        children: cfg.label || "分叉会话",
      });
    }

    function shippedComponent(id) {
      if (id === "pin") return ShippedPinRow;
      if (id === "archive") return ShippedArchiveRow;
      if (id === "fork") return ShippedForkRow;
      return null;   // rename：官方用内部对话框，只能隐藏
    }

    let disposers = [];

    function disposeAll() {
      const list = disposers.splice(0);
      for (const dispose of list) {
        try { dispose() } catch { /* 忽略 */ }
      }
    }

    /* ---------------- 官方悬停按钮的隐藏（DOM 级，确定性生效） ---------------- */
    /* 说明：插槽契约里的"复用官方 id 遮蔽"依赖框架自动分配的注册优先级，
       而优先级是每个插件各自计数的 —— 跨插件时并不可靠（官方注册得多、计数更靠前）。
       所以这里改用 DOM 级隐藏：按官方按钮的 aria-label 精确匹配，中英文都覆盖。 */
    const HIDE_STYLE_ID = "dsh-session-tool-hide-shipped";
    const ARCHIVE_LABELS = ["归档会话", "取消归档", "Archive session", "Unarchive session"];
    const PIN_LABELS = ["置顶会话", "取消置顶", "Pin session", "Unpin session"];

    /** 按当前配置同步"隐藏官方悬停按钮"的样式；返回注入的规则条数。 */
    function syncHiddenButtons() {
      try {
        const rules = [];
        if (CFG.shippedButtons.archive && CFG.shippedButtons.archive.hidden === true) {
          for (const label of ARCHIVE_LABELS) rules.push('button[aria-label="' + label + '"]');
        }
        if (CFG.shippedButtons.pin && CFG.shippedButtons.pin.hidden === true) {
          for (const label of PIN_LABELS) rules.push('button[aria-label="' + label + '"]');
        }
        let style = document.getElementById(HIDE_STYLE_ID);
        if (rules.length === 0) {
          if (style && style.parentNode) style.parentNode.removeChild(style);
          return 0;
        }
        if (!style) {
          style = document.createElement("style");
          style.id = HIDE_STYLE_ID;
          (document.head || document.documentElement).appendChild(style);
        }
        style.textContent = rules.join(",") + " { display: none !important; }";
        return rules.length;
      } catch { return -1; }
    }

    /**
     * 按当前配置注册全部界面项。
     * 同步执行、不碰网络也不等任何服务 —— 这样入口一定能立刻激活（不会停在 loading）。
     */
    function registerAll(ctx) {
      // ① ⋯ 菜单：我们的删除项
      if (CFG.menu.hidden !== true) {
        disposers.push(ctx.slots.inject(MENU_SLOT, function* () {
          yield ctx.slots.register({ name: MENU_SLOT, id: "dsh-session-tool.delete", order: CFG.menu.order }, DeleteSessionMenuItem);
        }));
      }

      // ② 官方菜单行：hidden 用同 id 空组件替换；label/order 用同 id 注册重写的行
      for (const id of Object.keys(SHIPPED_ORDER)) {
        const rowCfg = CFG.shippedRows[id] || {};
        const wantsRewrite = Boolean(rowCfg.label || rowCfg.activeLabel) || typeof rowCfg.order === "number";
        const component = rowCfg.hidden === true ? ShippedHidden : (wantsRewrite ? shippedComponent(id) : null);
        if (component === null) continue;
        const order = typeof rowCfg.order === "number" ? rowCfg.order : SHIPPED_ORDER[id];
        try {
          disposers.push(ctx.slots.inject(MENU_SLOT, function* () {
            yield ctx.slots.register({ name: MENU_SLOT, id, order }, component);
          }));
        } catch { /* 该行不可替换时忽略 */ }
      }

      // ③ 官方悬停按钮：只支持隐藏（用同 id 空组件替换）
      for (const id of Object.keys(SHIPPED_BUTTON_ORDER)) {
        const buttonCfg = CFG.shippedButtons[id] || {};
        if (buttonCfg.hidden !== true) continue;
        try {
          disposers.push(ctx.slots.inject(ROW_SLOT, function* () {
            yield ctx.slots.register({ name: ROW_SLOT, id, order: SHIPPED_BUTTON_ORDER[id] }, ShippedHidden);
          }));
        } catch { /* 该按钮不可替换时忽略 */ }
      }

      // ④ 对话区头部工具栏：重命名按钮（order -40 = 该队列最左，尽量贴近标题）
      //    用官方 actions 插槽，避免和 lineage 插槽里的官方子代理占位者抢 cell
      disposers.push(ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
        name: "conversation.session.header.actions",
        id: "dsh-session-tool.rename",
        order: -40,
      }, RenameSessionButton)));

      // ⑤ 官方悬停按钮的 DOM 级隐藏（与上面的 id 接管双保险）
      const hiddenRules = syncHiddenButtons();

      // ⑥ 根级弹窗
      disposers.push(ctx.slots.inject("shell.overlay", () => ctx.slots.register({ name: "shell.overlay", id: "dsh-session-tool.dialog", order: 500 }, DeleteSessionDialog)));
      disposers.push(ctx.slots.inject("shell.overlay", () => ctx.slots.register({ name: "shell.overlay", id: "dsh-session-tool.rename-dialog", order: 510 }, RenameSessionDialog)));
    }

    function apply(ctx) {
      if (!ctx.slots || typeof ctx.slots.register !== "function") return;
      ctxRef = ctx;
      registerAll(ctx);                          // 同步注册 → 入口立即激活（绝不阻塞）

      // 配置读取：失败/为空就重试几次（界面在配置到达后会自动重建注册）
      const tryLoad = (attempt) => {
        loadConfig().then((result) => {
          const hidden = Object.keys(CFG.shippedButtons || {}).filter((id) => CFG.shippedButtons[id] && CFG.shippedButtons[id].hidden === true);
          void diag([
            "config #" + attempt + ": " + result.note + " | changed=" + result.changed + " | menu.order=" + CFG.menu.order + " | hiddenButtons=" + (hidden.join(",") || "(none)") + " | cssRules=" + syncHiddenButtons(),
          ], result.note === "ok" ? "info" : "warn");
          if (result.note !== "ok" && attempt < 5) { setTimeout(() => tryLoad(attempt + 1), 2000); return; }
          if (result.changed !== true) return;
          disposeAll();
          registerAll(ctx);
          void diag(["re-registered with fetched config (hidden buttons: " + (hidden.join(",") || "none") + ", cssRules=" + syncHiddenButtons() + ")"], "info");
        }).catch(() => { /* loadConfig 自身已兜底 */ });
      };
      tryLoad(1);
    }

    exports.apply = apply;
    exports.inject = ["slots"];
    return module.exports;
  },
});
