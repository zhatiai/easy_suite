# Layout Specification

## 整体布局

- **UI Type**: `application-dashboard`
- **参考画布**: `1447 × 1087 px`（source: `reference-visible`, confidence: `1.0`, strictness: `required`）
- **生产容器**: `100vw × 100dvh`，最小高度沿用 420px（source: `inferred-implementation`, confidence: `0.98`, strictness: `recommended`）
- **布局模式**: Desktop CSS Grid；Mobile 单视图切换
- **生产列宽**: `220px navigation + clamp(300px, 25vw, 360px) explorer + 5px resizer + minmax(0,1fr) document`
- **现有兼容**: 用户可调 explorer 宽度保持 `220–440px`，默认从 300 调至 340px；宽度继续写入 `easynote-note-list-width`。

截图中的 238/338/804px 是 1380px 内窗的视觉事实；生产列宽是适配当前仓库的实现推断，source `inferred-implementation`、confidence `0.93`、strictness `recommended`。

## Desktop（> 1100px）

| 区域 | 定位/尺寸 | 溢出 | 层级/边界 | Source | Confidence | Strictness |
|---|---|---|---|---|---:|---|
| NavigationRail | grid col 1；220px；高 100dvh | 中段独立滚动，底部设置固定 | z1；右 1px border | inferred-implementation | 0.94 | recommended |
| NotebookExplorer | grid col 2；300–440px | header 固定；tree `overflow-y:auto` | z1；右侧 resizer | inferred-implementation | 0.95 | required |
| Resizer | grid col 3；5px | hidden overflow | 键盘可聚焦 separator | repository-existing | 0.99 | required |
| DocumentWorkspace | grid col 4；剩余宽度 | toolbar/footer 固定，正文滚动 | 最干净 surface | repository-existing | 0.99 | required |
| WorkspaceToolbar | 48px 高；12px 横向内距 | 工具组可按优先级收缩 | bottom hairline，z1 | repository-existing | 0.99 | required |
| DocumentScroll | 40px 横向 padding | `overflow:auto` | 正文 max 900/1080px | repository-existing | 0.99 | required |
| TagPopover | 触发器下方 8px；宽 280px；max-height min(420px,60dvh) | 选项区内部滚动 | z20；8px radius；panel shadow | inferred-implementation | 0.90 | recommended |

### NavigationRail 内部

- 顶部品牌区：56px 最小高；图标 32px；品牌两行允许副标题在宽度不足时隐藏。
- “新建笔记”改为安静的全宽导航行，不使用大面积实心蓝；高度 40px。
- 主导航行 40px，水平 padding 12px，图标 18px，gap 12px。
- 文件夹区只显示入口/根摘要与计数；完整树移到 NotebookExplorer。
- 标签区每行 36px：12px 色点、名称自适应、计数右对齐。
- 设置固定在底部，safe area 后仍可点击。

### NotebookExplorer 内部

- Header padding `20px 20px 12px`；标题行 36px；标题实现 22px/700。
- Search 高 40px，margin-top 12px，radius 8px；快捷键提示仅桌面展示。
- Tree padding `12px 12px 24px`；每级缩进 22px。
- 文件夹行高 40px；笔记行高 38px；选中行 radius 7px。
- 展开箭头 16px，文件夹/笔记图标 18px，行内 gap 9px。
- 行尾更多按钮 28px，仅 hover、focus-within、选中时显现；触屏始终可通过长按/操作表访问。

### Document 内部

- 正文容器仍使用左对齐的 `max-width:900px`（宽屏 1080px），不在宽视口居中。
- Desktop 顶部 padding 从 48px 保持不变；标题 32px/650/1.25。
- 元数据从纯文本行重组为 `DocumentMetaBar`：文件夹选择、标签触发器、创建/更新时间；gap 12px；可换行。
- 编辑器/预览保持 16px/1.7。标题、正文、预览与 CodeMirror 不得包进卡片。

## Medium（901–1100px）

- 保持三栏，但 NavigationRail 可由用户收起；文档 padding 降至 30px。
- 工具栏按优先级保留：返回/状态、编辑-预览、同步保存、更多；分享、PDF、历史、归档等进入“更多”。
- 不能通过水平滚动容纳图标。

## Tablet（641–900px）

- 左 NavigationRail 隐藏，NotebookExplorer + Document 两栏。
- “打开导航菜单”唤起左侧 sheet；sheet 内容沿用 NavigationRail 顺序。
- explorer 宽度默认 300px，仍可调；小于约 760px 时禁用拖动并固定 280px。

## Mobile（≤ 640px）

- 严格保持现有 list-to-document 状态机：同一时刻只显示 explorer 或 document。
- Explorer header sticky；菜单与搜索按钮触达尺寸至少 38px，主要动作至少 44px。
- 文件夹树使用渐进展开；笔记行可切换为两行摘要，禁止把桌面三栏压缩进 320px。
- 文档工具栏 50px；非核心动作进入 bottom sheet；文档 padding 20px（≤350px 为 17px）。
- 浮层标签选择器在移动端变为 bottom sheet，而不是 280px 绝对定位 popover。
- 必须处理 `env(safe-area-inset-*)`，不得产生横向滚动。

## 状态布局约束

| 状态 | 位置与行为 | Source | Confidence | Strictness |
|---|---|---|---:|---|
| loading | explorer tree 原位稀疏 skeleton/状态文案；不可清空整个壳 | inferred-implementation | 0.90 | recommended |
| empty | tree/content 区居中，单一主动作 | repository-existing | 0.96 | required |
| offline | 保存状态显示 WifiOff + 文案；仍可编辑本地草稿 | repository-existing | 0.99 | required |
| pending | 保存点使用 warning + “正在保存/待处理草稿”，不只变色 | repository-existing | 0.99 | required |
| error/conflict | 工具栏下方 inline alert；冲突继续用 dialog | repository-existing | 0.99 | required |
| deleted | 文档上方 trash banner；编辑控件 disabled | repository-existing | 0.99 | required |
| focus | 2px accent outline 或 3px focus ring，不因重构删除 | repository-existing | 0.99 | required |

## 宽度守恒检查

- 1440px 视口：`220 + 340 + 5 + 875 = 1440`，无溢出。
- 1024px 视口：`200 + 300 + 5 + 519 = 1024`；收缩工具栏而非正文横滚。
- 900px：左栏隐藏，`300 + 5 + 595 = 900`。
- 320–390px：单视图宽度 `100%`，所有 fixed/sheet 元素使用 `max-width:100%`。
