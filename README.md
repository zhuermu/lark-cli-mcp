# 用 lark-cli 封装 MCP，让 AI 助手「以你本人身份」发飞书消息

本手册教你把官方 **lark-cli** 封装成一个 MCP Server，配置到任意 MCP 客户端（Kiro / Cursor / Claude Desktop / Trae / 你的 quick 助手等），从而让 AI 助手能够：

- **以你本人身份**收发飞书消息（消息显示为你本人发送，而非机器人）
- 通过一个通用网关调用 lark-cli 的全部能力（日历、云盘、文档、多维表格、任务、邮件、会议…）

---

## 为什么用这种方式（而不是官方 lark-openapi-mcp）

官方 `@larksuiteoapi/lark-mcp` 也能连飞书，但在 **v0.5.1** 版本里，它的发消息工具 `im.v1.message.create` 存在缺陷：

- 工具 schema **缺少 `useUAT` 字段** → 你传的"用用户身份"参数会被丢弃
- 工具被标记 `accessTokens: ['tenant']` → 在 `user_access_token` 模式下**直接被过滤掉**

结果：通过官方 MCP 发出的消息 **sender 永远是机器人（app）**，无法"代替用户发消息"。

而 **lark-cli** 通过 `--as user` 天然支持以用户身份发送（实测 `sender_type: user`）。因此我们把 lark-cli 封装成 MCP，即可绕开该 bug、真正代替用户发消息。

参考：
- lark-cli 官方仓库：https://github.com/larksuite/cli
- 官方 MCP（对比）：https://github.com/larksuite/lark-openapi-mcp

---

## 前置条件

- **Node.js**（提供 `node` / `npm` / `npx`）。建议 LTS 或更高版本。
  ```bash
  node -v && npm -v
  ```

---

## 第一步：安装并登录 lark-cli

### 1.1 安装 CLI 和配套 Skill

```bash
# 安装 lark-cli（推荐）
npx @larksuite/cli@latest install

# 安装配套 AI Skill（本 MCP 网关会读取这些 skill 文档）
npx skills add larksuite/cli -y -g
```

安装后验证：

```bash
lark-cli --version
which lark-cli   # 记下路径，一般是 /opt/homebrew/bin/lark-cli 或 ~/.local/bin/lark-cli
```

### 1.2 配置应用凭证（一次性）

```bash
lark-cli config init
```

按提示在浏览器完成应用配置（需要一个飞书开放平台自建应用的 App ID / App Secret）。

> 要以用户身份发消息，请确保该应用在开放平台已开通 **`im:message`** 与 **`im:message.send_as_user`**（以用户身份发送消息）权限并发布版本。

### 1.3 登录（获取用户授权）

```bash
# --recommend 自动勾选常用 scope；也可用 --domain / --scope 精细控制
lark-cli auth login --recommend
```

在浏览器完成授权后验证：

```bash
lark-cli auth status --json --verify
```

看到 `identities.user.status: ready`（或 `needs_refresh`，会自动刷新）、以及你的 `userName` 即为成功。

---

## 第二步：创建 MCP 封装脚本 `server.js`

新建目录并保存下面的脚本，例如放到 `~/lark-cli-mcp/server.js`：

```bash
mkdir -p ~/lark-cli-mcp
```


### 环境变量（可选）

- `LARK_CLI_BIN`：lark-cli 可执行文件路径（默认 `lark-cli`，需在 PATH 中）
- `LARK_SKILLS_DIR`：skill 目录（默认 `~/.claude/skills`；脚本已自动处理符号链接）

---

## 第三步：接入 MCP 客户端（quick / Kiro / Cursor / Claude 等）

所有 MCP 客户端的配置格式都是同一份 **`mcpServers`** JSON，只是文件位置不同。把下面的条目加进去（**注意把 `args` 里的路径改成你实际的 `server.js` 绝对路径**）：

```json
{
  "mcpServers": {
    "lark-cli-mcp": {
      "command": "node",
      "args": [
        "/Users/你的用户名/lark-cli-mcp/server.js"
      ],
      "disabled": false,
      "autoApprove": [
        "lark_list_skills",
        "lark_read_skill",
        "lark_list_chats"
      ]
    }
  }
}
```

配置文件位置参考：

| 客户端 | 配置文件位置 |
|---|---|
| **quick / 其他 MCP 助手** | 参照其"添加 MCP Server"设置，粘贴上面的 `lark-cli-mcp` 条目 |
| **Kiro CLI** | 全局 `~/.kiro/settings/mcp.json`，或项目级 `.kiro/settings/mcp.json` |
| **Cursor** | `~/.cursor/mcp.json`（或项目 `.cursor/mcp.json`） |
| **Claude Desktop** | macOS: `~/Library/Application Support/Claude/claude_desktop_config.json` |

> **关于 autoApprove**：只放行只读工具（`lark_list_skills` / `lark_read_skill` / `lark_list_chats`）。
> **不要**把 `lark_run` 和 `lark_send_message` 放进 autoApprove——它们可能执行写操作/发消息，保留每次人工确认更安全。

配置完成后，**重启客户端**以加载 MCP。在 Kiro 里可用 `/mcp` 查看 `lark-cli-mcp` 是否 `✓ Initialized`、并列出 5 个工具。

---

## 第四步：验证「代替用户发消息」

在助手对话里让它发一条消息，例如：

> 用 lark_send_message 给我自己发一条测试消息

助手会调用 `lark_send_message`（默认 `identity=user`）。验证 sender 是本人：

```bash
# 用返回的 message_id 查询发送者
lark-cli im +messages-mget --message-ids om_xxxxxxxx --as user
```

在返回里应看到：

```json
"sender": { "id": "ou_...", "name": "你的名字", "sender_type": "user" }
```

`sender_type: user` 即代表**消息以你本人身份发送**（而不是 `app`/机器人）——目标达成。

---

## 工具速查

| 工具 | 说明 | 是否建议 autoApprove |
|---|---|---|
| `lark_list_skills` | 列出全部 lark-* skill 及描述 | ✅ 是（只读） |
| `lark_read_skill` | 读取某 skill 的 SKILL.md / 引用文档，学习正确命令 | ✅ 是（只读） |
| `lark_run` | 执行任意 lark-cli 命令（argv 数组），覆盖全部能力 | ❌ 否（可能写操作） |
| `lark_send_message` | 便捷发消息，`identity=user`(默认)/`bot` | ❌ 否（发消息需审核） |
| `lark_list_chats` | 列群，找 `chat_id` | ✅ 是（只读） |

**典型使用流程**（助手内部）：`lark_list_skills` → `lark_read_skill("lark-im")` → `lark_run(["im","+messages-send",...])`。

---

## 安全须知

- **以用户身份操作有风险**：授权后，AI 在你授权的 scope 范围内以你本人身份操作，可能因模型幻觉或提示注入导致误操作/数据泄露。建议将该应用机器人**仅作为你的私人助手**，不要拉进群或给他人使用。
- **写操作保留确认**：`lark_run` / `lark_send_message` 不放进 autoApprove；高风险命令 lark-cli 会以退出码 `10` + `confirmation_required` 拦截，助手应在你明确同意后才追加 `--yes` 重试。
- **无 shell 注入**：脚本用 `execFile(argv[])` 执行，不经过 shell，参数无需转义、也不会被 shell 解析。
- **不要输出密钥**：App Secret / access token 不应打印到终端；凭证由 lark-cli 存于系统级钥匙串/加密存储。
- **路径防穿越**：`lark_read_skill` 限制在 skill 目录内读取。

---

## 常见问题

- **助手里看不到工具**：确认已重启客户端；`server.js` 路径为绝对路径；`node` 在 PATH 中。
- **`lark-cli: command not found`**：设置 `LARK_CLI_BIN` 为绝对路径，或确保安装目录在 PATH。可 `which lark-cli` 查看。
- **发出来还是机器人身份**：确认调用时 `identity=user`；确认应用已开通并授权 `im:message.send_as_user`；必要时 `lark-cli auth login --scope "im:message im:message.send_as_user"` 重新授权。
- **提示需要确认（exit 10）**：这是高风险写操作的门禁，属正常保护；确认无误后由助手追加 `--yes` 重试。
- **`lark_list_skills` 返回 0**：确认 `LARK_SKILLS_DIR` 指向正确目录（默认 `~/.claude/skills`），且已执行 `npx skills add larksuite/cli -y -g`。

---

## 附：本地直接自测 MCP（不依赖客户端）

```bash
printf '%s\n%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1.0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | node ~/lark-cli-mcp/server.js
```

能看到 `initialize` 响应和 5 个工具的 `tools/list` 即为正常。
