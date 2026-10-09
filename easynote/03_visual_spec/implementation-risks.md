# Implementation Risks

## 高风险

| 项目 | 描述 | 建议方案 |
|---|---|---|
| 层级浏览器的数据完整性 | 当前 `book.notes` 是当前 view/query/tag/folder 的分页结果，不能假装它天然包含所有文件夹下全部笔记 | 在 `useNotebook.ts` 增加按 `view + folderId` 的 explorer summary cache；展开文件夹时通过现有 `api.notes` 懒加载，分页继续存在；不得把请求放进树组件 |
| 视觉重排破坏保存语义 | 把保存状态、文件夹、标签移动位置时，容易误改 autosave/revision/operationId | 只重排展示；所有写入继续调用 `setNoteFields`/`syncNow`，不从组件直接 `fetch` |
| 标签彩色圆点 | 当前标签只有字符串，没有颜色字段；把颜色当业务属性会引发 shared/Worker/D1 migration | 首期用标签文本稳定 hash 映射展示色，并保留文本；若要用户可编辑颜色，另立后端任务和 migration |
| 移动端桌面树复用 | 桌面层级树直接缩窄会导致 320px 溢出、hover-only 操作不可用 | ≤640px 继续单视图；动作移入 bottom sheet，行尾操作不得是唯一入口 |
| App.tsx 继续膨胀 | 当前 `App.tsx` 已承担大量编排，继续内联完整三栏会难以测试 | 提取纯 UI 组件，但 state/side-effect ownership 不迁移：`NavigationRail.tsx`、`NotebookExplorer.tsx`、`DocumentMetaBar.tsx` |

## 中风险

| 项目 | 描述 | 建议方案 |
|---|---|---|
| Tree keyboard semantics | 加 `role=tree` 却没有方向键模型会降低无障碍 | 首选语义 `<nav><ul><li><button>`；只有完整实现 ArrowLeft/Right/Up/Down/Home/End 才声明 tree role |
| 工具栏拥挤 | 中等宽度、英文文案和多个图标会挤压保存状态 | 定义动作优先级，901–1100px 将低频动作收进 More；状态允许截断但保留 accessible name |
| 标签浮层定位 | 当前浮层从 footer 向上展开，参考图位于元数据旁；靠近视口边缘可能溢出 | 触发器迁移到 meta bar，使用 CSS anchor/受控测量或稳定的相对容器；移动端改 dialog sheet |
| 主题适配 | 截图只有浅色，照抄 Hex 会破坏 dark/warm/white | 所有实现颜色使用现有 semantic CSS variables；4 主题截图回归 |
| 大列表性能 | 多文件夹同时展开可能渲染大量节点 | 默认只展开祖先链/用户记忆的少数文件夹；按文件夹分页并限制 DOM 节点；不引入新依赖前先测量 |
| 搜索含义 | 参考框写“搜索文件或笔记”，EasyNote 目前搜索笔记内容，不搜索文件夹名称 | 保持“搜索笔记”语义；若要搜索文件夹，先在 hook 定义组合结果与键盘行为 |

## 实施红线

- 不修改 Worker、D1、R2、共享契约来完成纯视觉重构。
- 不绕过 `api.ts`，不在组件内裸 `fetch`。
- 不移动 autosave、离线镜像、三方合并、冲突或文件缓存逻辑离开 `useNotebook.ts`/`drafts.ts`。
- 不用 `any`、非必要断言、吞错、硬编码单语言字符串。
- 不引入组件库、CSS-in-JS、Tailwind、新字体或第二套图标。
- 不缓存私有 API/笔记正文到 Service Worker。
- 不把 essential action 仅放在 hover 菜单里。

## 需脚本验证

| 项目 | 当前估算值 | 验证方式 |
|---|---|---|
| 参考 bbox | 人工测量，约 ±4px | 图像标注/像素测量工具 |
| muted 文本对比度 | 约 4.3:1 | 计算四主题实际 CSS computed color 的 WCAG ratio |
| 视觉接近度 | 未执行 | Playwright 在 1440×960、1024×768、390×844、320×740 截图 diff |
| 工具栏不溢出 | 规则推断 | 中文/英文分别断言 `scrollWidth <= clientWidth` |
| Tree 大数据性能 | 未测量 | 500/2000 笔记 fixture，记录渲染/展开耗时 |

## 低置信度汇总

| 项目 | 阶段 | Confidence | 影响范围 |
|---|---:|---:|---|
| 精确字体型号 | 3 | 0.55 | 不影响实现；固定系统字体栈 |
| 窗体外背景色 | 2 | 0.68 | 不实施到生产壳 |
| 浮层阴影 alpha | 2 | 0.64 | 使用现有 `--panel-shadow` |
| 标签颜色是否可编辑 | 1 | 0.52 | 首期明确不扩展数据模型 |

## 回滚边界

实现应分成可独立回滚的三层：

1. CSS/token 与布局壳；
2. 纯展示组件拆分；
3. explorer 懒加载/cache 行为。

若第 3 层未完成，前两层仍应可运行在现有 flat note list，不得以半完成 tree 阻塞编辑、离线或保存。
