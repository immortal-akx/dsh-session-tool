/**
 * dsh-session-tool 客户端半边（浏览器 bundle）。
 *
 * 在侧栏会话行的 "..." 菜单和悬停按钮里各加一个「删除会话」：
 *   - sidebar.workspaces.session.menu.item   （插槽直接给到 sessionId / displayTitle）
 *   - sidebar.workspaces.session.row.action
 *
 * 删除请求发到宿主半边的同源 HTTP 路由 POST /__dsh-session-tool/delete
 * （第三方插件无法新增 Typert RPC namespace，同源路由是可用路径）。
 * 默认进回收目录，可恢复；运行中的会话会二次确认后才停机删除。
 */
window.__ModuleLoader__.load({
  id: "dsh-session-tool",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const jsx = require("react/jsx-runtime").jsx;
    const P = require("@deepseek-ai/dsh-client-ui-primitives");

    const ENDPOINT = "/__dsh-session-tool/delete";
    const ZH = String(navigator.language || navigator.userLanguage || "").toLowerCase().startsWith("zh");
    const T = ZH
      ? {
          menu: "删除会话",
          confirm: (name) => '确定删除会话「' + name + '」？\n\n文件会移入回收目录（可手动恢复），侧栏上的这一行会消失。',
          running: (name) => '「' + name + '」正在运行。\n\n要先停止它再删除吗？',
          done: (name) => '已删除「' + name + '」。\n\n文件在 $DSH_HOME/session-trash 里，可手动恢复。',
          fail: (reason) => '删除失败：' + reason,
        }
      : {
          menu: "Delete session",
          confirm: (name) => 'Delete session "' + name + '"?\n\nIts log moves to the trash directory (recoverable) and the sidebar row disappears.',
          running: (name) => '"' + name + '" is running.\n\nStop it and delete anyway?',
          done: (name) => 'Deleted "' + name + '".\n\nThe log is under $DSH_HOME/session-trash if you need it back.',
          fail: (reason) => 'Delete failed: ' + reason,
        };

    const shortId = (id) => String(id || "").replace(/^session-/, "").slice(0, 8);

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

    async function deleteWithConfirm(sessionId, title) {
      if (!sessionId) return;
      const name = title || shortId(sessionId);
      if (!window.confirm(T.confirm(name))) return;
      try {
        let out = await callDelete(sessionId, {});
        if (out.status === 409 && out.data && out.data.code === "running") {
          if (!window.confirm(T.running(name))) return;
          out = await callDelete(sessionId, { stop: true });
        }
        if (out.status === 200 && out.data && out.data.ok) { window.alert(T.done(name)); return; }
        const first = (list) => (Array.isArray(list) && list.length > 0 ? String(list[0]) : "");
        const reason = (out.data && (out.data.error || first(out.data.failed) || first(out.data.refused))) || "HTTP " + out.status;
        window.alert(T.fail(reason));
      } catch (error) {
        window.alert(T.fail(String(error && error.message ? error.message : error)));
      }
    }

    /** 侧栏会话行 "..." 菜单里的一项。 */
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
        onSelect: () => { closeMenu(); void deleteWithConfirm(props.sessionId, props.displayTitle); },
        children: T.menu,
      });
    }

    /** 会话行悬停时出现在行尾的小按钮。 */
    function DeleteSessionRowButton(props) {
      const style = { display: "inline-flex", alignItems: "center", justifyContent: "center", width: 20, height: 20, padding: 0, border: "none", borderRadius: 4, background: "transparent", color: "inherit", cursor: "pointer" };
      return jsx(P.Tooltip, {
        label: T.menu,
        side: "bottom",
        align: "end",
        delayMs: 500,
        children: jsx("button", {
          type: "button",
          "aria-label": T.menu,
          style,
          onClick: (event) => {
            if (event && typeof event.stopPropagation === "function") event.stopPropagation();
            void deleteWithConfirm(props.sessionId, props.displayTitle);
          },
          children: jsx(P.IconTrashOutlineRegular, { size: 14 }),
        }),
      });
    }

    function apply(ctx) {
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
    }

    exports.apply = apply;
    exports.inject = [];
    return module.exports;
  },
});
