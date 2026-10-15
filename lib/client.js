/**
 * dsh-session-tool 客户端半边（浏览器 bundle）。
 *
 * 侧栏每个会话行加「删除会话」入口（"..." 菜单项 + 悬停按钮），
 * 点击后弹出应用内确认弹窗（Modal + 必须勾选的风险确认），
 * 确认后请求宿主半边的同源路由 POST /__dsh-session-tool/delete。
 *
 * 第三方插件无法新增 Typert RPC namespace，同源 HTTP 路由是与宿主通信的可用路径。
 * 弹窗挂在 shell.overlay（根级浮层）上，因此菜单关闭后弹窗依然存在。
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

    const ENDPOINT = "/__dsh-session-tool/delete";
    const ZH = String(navigator.language || navigator.userLanguage || "").toLowerCase().startsWith("zh");
    const T = ZH
      ? {
          menu: "删除会话",
          title: "删除会话",
          label: "会话",
          desc: "该会话的日志会被移入回收目录（可手动恢复），并从侧栏消失。运行中的会话会被先停止。",
          ack: "我已了解后果，确认删除",
          cancel: "取消",
          del: "删除",
          deleting: "删除中…",
          runningTitle: "该会话正在运行",
          runningDesc: "删除会立即停止它正在进行的任务，且无法恢复该任务的进度。",
          runningAck: "停止它并删除",
          stopDel: "停止并删除",
          done: (name) => "已删除「" + name + "」。（文件在回收目录，可恢复）",
          fail: (reason) => "删除失败：" + reason,
        }
      : {
          menu: "Delete session",
          title: "Delete session",
          label: "Session",
          desc: "Its log moves to the trash directory (recoverable) and the sidebar row disappears. A running session is stopped first.",
          ack: "I understand the consequences",
          cancel: "Cancel",
          del: "Delete",
          deleting: "Deleting…",
          runningTitle: "This session is running",
          runningDesc: "Deleting stops its in-flight work immediately; that work cannot be resumed.",
          runningAck: "Stop it and delete",
          stopDel: "Stop and delete",
          done: (name) => 'Deleted "' + name + '". (The log is in the trash directory and can be restored.)',
          fail: (reason) => "Delete failed: " + reason,
        };

    const shortId = (id) => String(id || "").replace(/^session-/, "").slice(0, 8);

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

    async function callDelete(sessionId, extra) {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(Object.assign({ sessionIds: [sessionId] }, extra || {})),
      });
      let data = {};
      try { data = await res.json(); } catch { /* 空响应体 */ }
      return { status: res.status, data };
    }

    /* ------------------------------- 确认弹窗 ------------------------------- */
    function DeleteSessionDialog() {
      const active = useRequest();
      const [ack, setAck] = React.useState(false);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState("");
      const [runningStep, setRunningStep] = React.useState(false);
      const key = active ? active.sessionId + "|" + String(active.title || "") : "";

      React.useEffect(() => {
        setAck(false); setBusy(false); setError(""); setRunningStep(false);
      }, [key]);

      if (!active) return null;
      const name = active.title || shortId(active.sessionId);

      const close = () => { if (!busy) setRequest(null); };
      const confirm = async () => {
        setBusy(true); setError("");
        try {
          let out = await callDelete(active.sessionId, runningStep ? { stop: true } : {});
          if (out.status === 409 && out.data && out.data.code === "running" && !runningStep) {
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

      const rowStyle = { margin: "0 0 10px", lineHeight: "20px", color: "var(--dsw-alias-label-primary)" };
      const dimStyle = { color: "var(--dsw-alias-label-secondary)" };
      return jsx(P.Modal, {
        open: true,
        onClose: close,
        title: runningStep ? T.runningTitle : T.title,
        footer: jsxs(React.Fragment, {
          children: [
            jsx(P.Button, { onClick: close, disabled: busy, children: T.cancel }),
            jsx(P.Button, {
              variant: "primary",
              disabled: busy || ack !== true,
              onClick: () => { void confirm(); },
              children: busy ? T.deleting : (runningStep ? T.stopDel : T.del),
            }),
          ],
        }),
        children: jsxs("div", {
          style: { display: "flex", flexDirection: "column", gap: "4px", minWidth: "320px" },
          children: [
            jsxs("div", { style: rowStyle, children: [jsx("span", { style: dimStyle, children: T.label + "：" }), name] }),
            jsx("div", { style: Object.assign({}, rowStyle, { fontSize: "13px" }), children: runningStep ? T.runningDesc : T.desc }),
            jsx("div", { style: { marginTop: "6px" }, children: jsx(P.Checkbox, {
              checked: ack,
              onChange: (next) => setAck(next === true),
              label: runningStep ? T.runningAck : T.ack,
            }) }),
            error !== "" ? jsx("div", { style: { marginTop: "8px", fontSize: "13px", color: "var(--dsw-alias-label-error, #d64b4b)" }, children: error }) : null,
          ],
        }),
      });
    }

    /* ------------------------------- 触发入口 ------------------------------- */
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
      const style = { display: "inline-flex", alignItems: "center", justifyContent: "center", width: 20, height: 20, padding: 0, border: "none", borderRadius: 4, background: "transparent", color: "inherit", cursor: "pointer" };
      return jsx(P.Tooltip, {
        label: T.menu, side: "bottom", align: "end", delayMs: 500,
        children: jsx("button", {
          type: "button", "aria-label": T.menu, style,
          onClick: (event) => {
            if (event && typeof event.stopPropagation === "function") event.stopPropagation();
            openDialog(props.sessionId, props.displayTitle);
          },
          children: jsx(P.IconTrashOutlineRegular, { size: 14 }),
        }),
      });
    }

    function apply(ctx) {
      // slots 服务由 @deepseek-ai/dsh-client-ui-renderer 提供；已在 inject 里声明等待就绪
      if (!ctx.slots || typeof ctx.slots.register !== "function") return;
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
      ctx.slots.inject("shell.overlay", () => ctx.slots.register({
        name: "shell.overlay",
        id: "dsh-session-tool.dialog",
        order: 500,
      }, DeleteSessionDialog));
    }

    exports.apply = apply;
    // inject 里写的是【服务名】：等 renderer 的 slots 服务就绪后再 apply
    exports.inject = ["slots"];
    return module.exports;
  },
});
