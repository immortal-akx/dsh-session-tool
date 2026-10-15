# dsh-session-tool
给 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）补上**删除会话**能力的宿主插件。

DSH 官方只有「归档」—— 归档只是把会话从界面隐藏，日志文件原封不动躺在磁盘上，没有删除入口。本插件补上这个能力。

## 特性

- **斜杠命令**：`/sessions-archived` 查看、`/sessions-delete` 删除（`/` 菜单自动出现，无需客户端界面）
- **agent 工具**：`session_archived_list` / `session_delete`，模型可直接调用
- **默认安全**：删除先进回收目录，`--purge` 才永久删除；`--yes` 显式确认；拒绝删除当前会话
- **运行中的会话**默认拒绝删除，`--stop` 才先取消回合并等待静默
- **完整清理链路**：日志目录 + 投影缓存 + 工作区记账（含归档集合）一起清，走活的 `storageDomain`，内存与磁盘一致
- **零依赖**：只用 Node 内置模块 + DSH 宿主服务，不 import 任何 `@deepseek-ai` 的值

## 安装

> ⚠️ 下面命令里的 `<profile>` 是**占位符**，请替换成你自己的 profile 名，
> **不要把尖括号一起输入**。常见值：Web / TUI 端用 `web`，桌面端用 `desktop`。

### 一行搞定（Web 端，可直接复制粘贴）

```console
dsh plugin --profile web add dsh-session-tool
```

> 桌面端把 `web` 换成 `desktop`；其他 profile 换成你自己的名字。

### 其他安装方式

**从 GitHub 安装**（npm 镜像尚未同步时可用）：

```console
dsh plugin --profile web add github:immortal-akx/dsh-session-tool
```

**从本地开发目录安装**：

```console
dsh plugin --profile web add file:C:/path/to/dsh-session-tool
```

### 装完重启

安装后**重启 DSH** 生效（Host 插件在启动时加载）。

## 用法

在任意会话输入框敲 `/`：

| 命令 | 作用 |
| --- | --- |
| `/sessions-archived` | 列出已归档会话：标题 / 创建时间 / 占用 / id / 是否运行中 / 文件是否还在 |
| `/sessions-delete` | 删除已归档会话 |

```text
/sessions-delete                            预览：将删哪些（不动手）
/sessions-delete all --yes                  删除全部 → 移入回收目录
/sessions-delete 1,3 --yes                  按序号删
/sessions-delete 6cf4aa57 --yes             按 id 前缀删
/sessions-delete all --stop --yes           连"正在运行"的会话也删（先停止其任务）
/sessions-delete all --purge --yes          永久删除（不进回收目录）
```

删除后文件在 `$DSH_HOME/session-trash/<时间戳>/`，想恢复就把 `session-<id>` 文件夹搬回 `$DSH_HOME/sessions/<原分组>/`。

## agent 工具

| 工具 | 参数 |
| --- | --- |
| `session_archived_list` | 无 |
| `session_delete` | `sessionIds`（必填）、`purge`（默认 false = 进回收目录）、`stop`（默认 false = 拒绝运行中的会话） |

## 安全设计

1. **默认不真删** —— 移到 `$DSH_HOME/session-trash/<时间戳>/`，可手动恢复
2. **必须显式确认** —— 不带 `--yes` 只预览
3. **拒绝删当前会话** —— 正在对话的这个会被跳过
4. **运行中的会话默认拒绝** —— `--stop` 才先 `agent.cancel()` + 等静默（15 秒上限）
5. **删前先 flush + detach** —— 把会话从内存表摘除，避免 dispose 阶段把日志目录重建回来
6. **先删文件、后动记账** —— 文件确认删净才清记账，半删的会话不会掉进「未分组」
7. **走活的 storageDomain 清账** —— 投影缓存行、工作区 `sessionIds`、归档集合三处一起改
8. **陈旧登记** —— 归档表里有 id 但文件早没了的，只清理登记

## 实现

- 宿主插件：`ctx.commands.register()` 注册斜杠命令，`ctx.get('tools').register()` 注册工具
- 只依赖宿主服务：`commands` / `tools` / `agents` / `sessions` / `storageDomain` / `workspaceRegistry`
- 入口 `lib/index.js`，挂载声明 `cordis.patch.yml`

> 为什么不做侧栏按钮：DSH 客户端↔宿主是代码生成的 Typert RPC，第三方插件无法新增接口。斜杠命令 + agent 工具是插件可用的官方入口。

## 卸载

```console
dsh plugin --profile <profile> remove dsh-session-tool
```

## 许可

MIT

## 致谢

删除链路的部分设计（先删文件后动记账、走 live storageDomain 清账、运行中会话处理）参考了 [@pepsi-ai/dsh-plugin-session-delete](https://github.com/pepsi-ai/dsh-session-delete)。
