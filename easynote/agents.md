# EasyNote 开发代理规范

本文件适用于在 `easynote/` 目录及其子目录中进行开发的人员和编码代理。

## 开始工作前

1. 必须先阅读 [`project.md`](project.md)，理解模块边界、数据流、安全模型和验证矩阵。
2. 再阅读与任务直接相关的源码、测试和专题文档；不要仅凭 README 或文件名推断实现。
3. 检查 `git status`，保留用户已有改动，不回滚、不覆盖、不顺手重构无关代码。
4. 写明本次改动的成功条件以及准备执行的验证命令。

## 分支命名

- 功能开发分支统一使用：`feature/xiaoai/<short-description>`。
- `<short-description>` 使用小写英文和连字符，表达单一任务，例如：
  - `feature/xiaoai/offline-search`
  - `feature/xiaoai/share-expiry`
  - `feature/xiaoai/project-docs`
- 不直接在 `main` 上开发；开始修改前先创建或切换到符合规范的分支。
- 不擅自提交、推送、合并、变基或删除分支；只有用户明确要求时才执行。

## 编码原则

- 做最小、聚焦的改动。不要顺带格式化、改名或重构无关代码。
- 复用现有模块边界：UI 编排放在组件，笔记状态放在 `useNotebook.ts`，浏览器请求放在 `api.ts`，服务端领域逻辑放在对应 `src/worker/*` 模块，共用契约放在 `src/shared/`。
- 前端和服务端都要保持 TypeScript 严格类型；不要用 `any`、非必要断言或吞掉错误来绕过类型检查。
- 所有私有服务端查询都必须按 `user_id` 隔离。写 API 必须保留会话/Origin/CSRF 或 AI Token 权限边界。
- 修改笔记写入时必须保留 revision 乐观并发、operationId 幂等、版本历史、墓碑、文件引用和增量同步语义。
- 修改离线能力时必须同时考虑 IndexedDB 镜像、待同步草稿、断网冷启动、恢复联网和冲突合并。
- 新增或修改界面文案时同时维护中英文翻译，并通过 i18n 检查。
- 不提交 `.dev.vars*`、`wrangler.deploy.json`、备份、日志、`dist/`、`node_modules/`、`.wrangler/` 或测试报告。
- 不在代码、命令输出、测试数据或文档中写入真实密码、Cookie、恢复代码或 Cloudflare/AI Token。

## 变更后的验证

先按 [`project.md` 的验证矩阵](project.md#7-测试架构与验证方式) 选择与改动匹配的测试，至少执行：

```bash
npm run check
npm run build
```

按范围追加：

```bash
# Worker、API、共享数据模型、同步或安全逻辑
npm run test:api

# AI、MCP、集成令牌或集成 API
npm run test:ai

# 初始化、开发、部署、备份、恢复或密码重置脚本
npm run test:scripts

# React UI、样式、编辑器、离线/PWA 或端到端交互
npm run test:ui

# Worker 绑定或生产部署配置（只预检，不部署）
bash deploy.sh --check
```

验证要求：

1. 优先运行最接近改动的测试，再运行完整构建。
2. 修复由本次改动造成的失败后重新执行，直到通过。
3. 不为通过测试而删除断言、跳过用例、降低安全校验或扩大超时。
4. 若环境原因无法执行某项验证，交付时明确列出未执行的命令、原因和风险。
5. 交付说明包含改动文件、关键行为、已执行命令及结果；不要声称未执行的测试已通过。

## 高风险操作

- 生产部署、远程 migration、恢复、清库、永久删除数据以及任何真实账号/资源操作，必须得到用户明确授权。
- 默认只使用本地 Miniflare、隔离测试数据库和测试 R2。
- 数据库变更、认证/租户隔离、永久删除、离线冲突和公开分享属于高风险区域，必须补充相应的失败路径与跨租户测试。

如果本文与代码事实不一致，先核对测试和运行配置；在同一改动中修正失效文档，避免继续传播错误约定。
