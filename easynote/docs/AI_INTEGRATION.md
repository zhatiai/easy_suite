# EasyNote AI 接入

[简体中文](AI_INTEGRATION.md) | [English](AI_INTEGRATION.en.md)

EasyNote 在部署后的 `/mcp` 提供远程 Streamable HTTP MCP。用户不需要下载源码、安装 Node.js 或运行本地桥接器：

```text
AI 客户端 → https://EasyNote 地址/mcp → D1 / R2
```

## 创建令牌

登录 EasyNote，打开“设置”，在“AI 接入”中创建令牌：

- 名称：显示在令牌列表和历史版本中，例如“我的 Codex”。
- 权限：需要 AI 修改笔记时选择“读取和写入”，仅检索时选择“只读”。
- 有效期：30、90、365 天或永久。

创建后立即复制 `enai_...` 令牌。明文令牌只显示一次。

## 连接 Codex

创建令牌后点击“复制 Codex 配置”，将内容加入 `~/.codex/config.toml`：

```toml
[mcp_servers.easynote]
url = "https://你的-EasyNote-域名/mcp"
http_headers = { Authorization = "Bearer enai_..." }
```

重启 Codex，然后使用 `/mcp` 检查连接。Codex 桌面端也可在“设置 → MCP servers”中添加同一个 Streamable HTTP URL。

如需避免在配置文件中保存令牌，可先设置环境变量：

```bash
export EASYNOTE_TOKEN='enai_...'
```

再将配置中的 `http_headers` 替换为：

```toml
bearer_token_env_var = "EASYNOTE_TOKEN"
```

`bearer_token_env_var` 必须填写环境变量名称，不能填写 `enai_...` 令牌本身。直接配置方式会在 `config.toml` 中保存明文令牌，不要共享或提交该文件。

## MCP 工具

| 工具 | 权限 | 用途 |
| --- | --- | --- |
| `easynote_search_notes` | 只读 | 默认同时搜索正常和归档笔记，返回命中上下文、字符范围和分页信息 |
| `easynote_list_recent` | 只读 | 列出最近笔记 |
| `easynote_read_note` | 只读 | 分段读取一篇完整笔记 |
| `easynote_read_notes` | 只读 | 批量读取最多 20 篇笔记 |
| `easynote_get_note_links` | 只读 | 分页查询入链或出链，返回目标摘要、WikiLink、Resource URI 和不可用目标 |
| `easynote_connection_status` | 只读 | 验证账号、令牌名称和权限 |
| `easynote_note_stats` | 只读 | 精确统计正常、归档、回收站及全部笔记数量 |
| `easynote_list_folders` | 只读 | 列出完整文件夹树和每个文件夹的直接笔记数 |
| `easynote_create_note` | 读写 | 创建笔记并通过 `linked_note_ids` 一次关联最多 20 篇已有笔记 |
| `easynote_link_notes` | 读写 | 为已有笔记追加关联，自动去重，保留 revision 校验 |
| `easynote_update_note` | 读写 | 更新笔记，或通过 `folderId` 移动笔记 |
| `easynote_create_folder` | 读写 | 创建根文件夹或子文件夹 |
| `easynote_update_folder` | 读写 | 改名或移动文件夹 |
| `easynote_delete_folder` | 读写 | 删除文件夹树，笔记移到根目录，完全空白笔记移入回收站 |
| `easynote_archive_note` | 读写 | 归档或取消归档 |
| `easynote_trash_note` | 读写 | 移入回收站 |

只读令牌不会暴露写入工具。永久删除、账号管理、令牌管理和文件上传仍由 EasyNote 网页管理。

## MCP Resources

每篇笔记可通过 `easynote://notes/{id}.md` 读取为 `text/markdown`。Resource 列表仅用于浏览最近更新的正常和归档笔记，最多 100 篇；搜索仍覆盖整个知识库。

## 使用建议

```text
检索时先调用 easynote_search_notes；默认 view=any，不遗漏归档知识。
统计笔记数量时调用 easynote_note_stats，不要使用分页搜索结果或 Resource 数量推算。
正文命中结果提供 startOffset 和 endOffset，可将 startOffset 交给 easynote_read_note，只读取相关区段。
需要多篇正文时优先调用 easynote_read_notes。
上传时已经知道关联目标 ID，可直接使用 easynote_create_note 的 linked_note_ids，同时写入正文和链接。
创建请求可预先生成 id 与 operation_id；超时后复用这两个值及相同输入重试，避免重复创建。
写入结果返回 link 与 uri，后续引用可以直接复用。
仅追加关联时使用 easynote_link_notes，避免调用端重新上传整篇正文。
查看引用关系时使用 easynote_get_note_links，direction=incoming 表示哪些笔记引用了当前笔记，outgoing 表示当前笔记引用了哪些笔记。
nextOffset 非空时继续分页，即使当前候选页没有有效引用。missingIds 表示当前账号无法读取的出链目标。
修改时将最近一次读取或写入返回的 revision 作为 expected_revision；未知或发生冲突时再调用 easynote_read_note。
遇到 409 冲突时停止写入，重新读取后处理。
标题不带 #；正文顶级章节从 ## 开始。
删除使用 easynote_trash_note；永久删除由用户在网页中确认。
```

### 关联写入与重试

`linked_note_ids` 中的目标必须属于当前账号且未进入回收站。服务端批量读取标题，向正文追加稳定的 WikiLink，多篇目标使用 Markdown 列表。已有有效链接会去重，目标笔记的正文与 revision 保持原值。保存沿用版本历史、幂等操作、附件引用和增量同步流程。

`easynote_link_notes` 需要 `id`、`expected_revision` 和 `linked_note_ids`。删除关联时，通过 `easynote_update_note` 编辑对应 Markdown。反向链接从正文引用自动计算。

创建请求重试须同时复用 `id`、`operation_id` 与原始内容和关联目标。目标改名不会使已成功创建的重试变成新写入。相同操作 ID 搭配不同输入会返回冲突。

## 连接 ChatGPT 网页版

ChatGPT 网页版使用 OAuth 授权，不能填写静态令牌。在 ChatGPT 的 MCP 应用设置中添加：

- 服务器地址：`https://你的-EasyNote-域名/mcp`
- 认证方式：OAuth（客户端自动注册，PKCE）

ChatGPT 会打开 EasyNote 的授权页，输入账号密码并选择只读或读写权限后完成授权。每次授权生成一个“ChatGPT”令牌，出现在“设置 → AI 接入”中，可随时撤销。访问令牌 1 小时有效，刷新令牌 30 天有效，每次刷新都会轮换；重复使用旧刷新令牌会撤销该授权。

OAuth 端点：`/.well-known/oauth-protected-resource/mcp`、`/.well-known/oauth-authorization-server`、`/oauth/register`、`/oauth/authorize`、`/oauth/token`。仅 HTTPS 可用。


## 安全边界

- `/mcp` 只接受 HTTPS；本地开发回环地址除外。
- 每次 MCP 请求都验证独立 Bearer 令牌、有效期、撤销状态、账号状态和权限。
- AI 写入进入正常版本历史，并标记为 `AI：<令牌名称>`。
- 跨站浏览器请求被拒绝。
- 每个账号最多保留 10 个有效令牌，令牌可随时在设置中撤销。

## 故障排查

- `401`：令牌无效、过期或已撤销。
- `403`：只读令牌尝试写入，或请求不是 HTTPS。
- `409`：笔记 revision 已变化，应重新读取。
- `405`：MCP 地址错误或客户端没有使用 Streamable HTTP POST。
- 找不到工具：确认地址以 `/mcp` 结尾，并重启 Codex。

`npm run test:ai` 使用真实 Streamable HTTP MCP 客户端检查搜索、读取、写入、Resources、权限隔离和 revision 冲突。

## 内置笔记问答

在「设置 → LLM 配置」中填写 OpenAI 兼容服务的 API 基础地址（例如 `https://api.openai.com/v1`）、模型名称和 API Key，然后保存。此配置按账号保存在当前浏览器，不上传服务器，不随笔记备份或同步；可用「清除配置」移除。密钥对当前浏览器中的应用脚本可见，请使用权限和额度受限的密钥。

浏览器通过 OpenAI SDK 的 Chat Completions 接口直接访问供应商，因此供应商必须允许 CORS，并支持 `stream: true` 的文本流响应。地址支持 HTTPS，以及环回地址的 HTTP；请填写基础地址而非 `/chat/completions` 完整路径。此配置与供外部工具访问 EasyNote 的 MCP 令牌互相独立。

在笔记工具栏点击「AI 问答」（手机上位于「更多笔记操作」），会在原目录面板位置打开对话，不会自动发送内容。用户输入并发送问题后，才会附上当前笔记和已有对话。阅读模式中选中文字后，点击选区上方的「向 AI 提问」，会先将选中内容滚到阅读区上方，再在选区下方打开对话框。桌面初始宽度为正文的 80% 并居中，AI 消息在左、用户消息在右。可拖动四边或四角调整大小，也可聚焦边缘后用方向键调整。窗口始终限定在选区下方与阅读区内。问答期间底层笔记锁定滚动，窗口内可滚动会话，Escape 可关闭对话并恢复原阅读位置。输入区支持折叠和展开，折叠时保留草稿。提交问题后默认只发送选中文字和对话。勾选「发送选中内容上下文」会附上选区所在完整段落及随后一个段落，遇到下一节标题时停止。模型被要求使用 Markdown 回答，文本逐步输出并实时渲染标题、列表、表格、代码及公式；Mermaid 图表在生成结束后渲染。可停止生成并保留已收到的内容，失败后可使用原问题和上下文重试。Ctrl/⌘ + Enter 发送，Enter 换行；生成时可继续编辑下一条问题。上翻阅读历史会暂停自动滚动到底部。对话仅保留在当前页面内存中，关闭或切换笔记后结束，不写回笔记正文。
