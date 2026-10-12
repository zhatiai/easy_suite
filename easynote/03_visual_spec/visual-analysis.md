# EasyNote 参考图视觉分析

> 本文只把截图中能看到的事实标为 `reference-visible`。与当前 EasyNote 架构、响应式和交互有关的内容均标为推断，不把截图外信息伪装成视觉事实。

## 1. 全局构图

- **UI Type**: `application-dashboard`
- **UI Type Confidence**: `0.98`（high，source: `reference-visible`，strictness: `required`）
- **页面尺寸**: `1447 × 1087 px`
- **宽高比**: `1.331`
- **主视觉模型**: `structured-layout`

### UI Type Rationale

1. 截图有清晰的全局导航、层级笔记浏览器和文档工作区三栏，均有独立边界。
2. 右侧是可编辑文档与工具栏，不是图片主导的落地页或静态海报。
3. 标签选择器覆盖文档元数据区，是标准应用浮层。

### Visible Element Inventory

以下 bbox 均基于 1447 × 1087 截图人工测量，允许约 ±4 px；source 均为 `reference-visible`，strictness 均为 `recommended`。

| 元素 | bbox `x,y,w,h` | 视觉证据 | Confidence |
|---|---:|---|---:|
| 应用窗体 | `34,47,1380,993` | 大圆角浅色容器及外部淡蓝灰背景 | 0.96 |
| 全局导航栏 | `34,47,238,993` | 品牌、主导航、文件夹/标签摘要、底部设置 | 0.97 |
| 笔记浏览器 | `272,47,338,993` | “全部笔记”、搜索、嵌套文件夹与笔记行 | 0.97 |
| 文档工作区 | `610,47,804,993` | 保存状态、工具栏、标题、元数据、正文 | 0.98 |
| 工作区工具栏 | `610,47,804,90` | 底部分隔线；左侧保存状态、右侧图标组 | 0.96 |
| 保存状态组 | `643,80,150,42` | 绿色圆形勾、两行“已保存到云端/今天 10:24” | 0.94 |
| 文档标题 | `644,188,245,51` | 40px 左右粗体“未命名笔记” | 0.97 |
| 文档元数据行 | `644,258,606,48` | 文件夹按钮、加号、标签按钮、日期 | 0.94 |
| 正文编辑起点 | `643,358,260,43` | 蓝灰占位文字及深色插入光标 | 0.92 |
| 标签选择浮层 | `870,310,306,480` | 搜索框、7 个复选项、分隔线和新建标签 | 0.97 |
| 左栏当前导航项 | `52,247,205,44` | 蓝色文档图标、浅蓝选中面、“全部笔记” | 0.96 |
| 中栏搜索框 | `294,140,293,47` | 搜索图标、占位文字与 `⌘ K` | 0.96 |
| 中栏选中笔记行 | `382,342,216,43` | 浅蓝选中面、文档图标、更多操作 | 0.95 |

### Rejected Assumptions

| 假设组件/结构 | 拒绝原因 | 实施影响 |
|---|---|---|
| 固定 macOS 红黄绿窗口按钮 | 它们属于效果图窗体装饰，不是 Web/PWA 业务控件 | 浏览器/PWA 不渲染伪窗口按钮；原生宿主可由宿主窗口提供 |
| 页面外围 34px 留白与整窗阴影 | 只适合展示稿；真实应用需要占满 `100dvh` | 不给生产应用添加桌面壁纸式外框 |
| 可编辑标签颜色 | 截图只显示彩色圆点，未显示颜色编辑流程 | 首期仅做确定性展示色；不扩展数据模型 |
| 文档右侧常驻详情栏 | 截图中没有独立右栏 bbox | 保留现有按需 `knowledge-panel`，不新增常驻栏 |
| 截图中的图片/@/更多图标对应全新业务 | 静态图无法证明具体命令语义 | 只映射到 EasyNote 已有上传、分享、历史等操作 |
| 所有文件夹一次性加载全部笔记 | 截图展示样例数据，不能证明大数据策略 | 必须保留分页/按文件夹懒加载能力 |

### Asset Strategy

| 资产/视觉层 | 实现方式 | 原因 | Source | Confidence | Strictness |
|---|---|---|---|---:|---|
| 应用结构、面板、行、浮层 | React + 现有全局 CSS | 都是可访问的结构化控件 | reference-visible | 0.98 | required |
| 图标 | 现有 `lucide-react` | 参考图均为线性图标，项目已有唯一图标族 | inferred-implementation | 0.96 | required |
| 品牌图标 | 复用 `/easynote-icon.svg` | 当前产品资产已存在，不从截图重绘 | inferred-implementation | 0.99 | required |
| 标签色点 | CSS 变量 + 稳定字符串散列 | 截图有色点，但当前 Tag 仅为字符串 | screenshot-inferred | 0.74 | recommended |
| 窗体/背景光影 | 不作为资产 | 生产 Web 工作区应全屏，不复刻展示稿背景 | inferred-implementation | 0.94 | required |

### 视觉区域

| 区域 | 边界框 | 层级 | 背景/实现方式 | Source | Confidence | Strictness |
|---|---|---:|---|---|---:|---|
| 全局导航 | `34,47,238,993` | 1 | 冷灰浅表面，右侧 hairline | reference-visible | 0.95 | recommended |
| 浏览器 | `272,47,338,993` | 1 | 更接近白色的浅表面，右侧 hairline | reference-visible | 0.95 | recommended |
| 文档 | `610,47,804,993` | 1 | 最干净的白色表面 | reference-visible | 0.98 | required |
| 标签浮层 | `870,310,306,480` | 20 | elevated surface + border + shadow | reference-visible | 0.96 | recommended |

## 2. 颜色系统

截图颜色是视觉估算；实现必须映射到 `src/client/styles.css` 现有语义变量，而不是复制浅色主题色值。

| Token 名 | 估算 Hex | 角色 | 出现位置 | Source | Confidence | Strictness |
|---|---|---|---|---|---:|---|
| `color.canvas` | `#F4F8FD` | background | 应用窗体外部效果图背景 | screenshot-estimated | 0.68 | flexible |
| `color.sidebar` | `#F7F9FC` | surface | 左导航 | screenshot-estimated | 0.76 | recommended |
| `color.listPane` | `#FBFCFE` | surface | 中栏 | screenshot-estimated | 0.76 | recommended |
| `color.paper` | `#FFFFFF` | surface | 文档与浮层 | screenshot-estimated | 0.96 | required |
| `color.ink` | `#0C1B3A` | text-primary | 标题、主要标签 | screenshot-estimated | 0.83 | recommended |
| `color.muted` | `#697A9C` | text-secondary | 保存时间、占位、日期 | screenshot-estimated | 0.72 | recommended |
| `color.line` | `#E3E9F2` | border | 栏分隔线、工具栏底线 | screenshot-estimated | 0.78 | recommended |
| `color.accent` | `#087CFF` | accent | 图标、选中态、品牌 | screenshot-estimated | 0.91 | required |
| `color.accentSoft` | `#EAF3FF` | selected surface | 当前导航、当前笔记 | screenshot-estimated | 0.82 | recommended |
| `color.success` | `#22A96B` | success | 保存状态圆形勾 | screenshot-estimated | 0.83 | recommended |
| `color.elevatedShadow` | `rgba(35,58,93,.13)` | shadow | 标签浮层 | screenshot-estimated | 0.64 | flexible |

### 估算对比度

| 前景 | 背景 | 估算比值 | 备注 |
|---|---|---:|---|
| `color.ink` | `color.paper` | 约 `15:1` | estimated-contrast；应保持 WCAG AA |
| `color.muted` | `color.paper` | 约 `4.3:1` | estimated-contrast；12–14px 文本需脚本复核 |
| `color.accent` | `color.accentSoft` | 约 `3.5:1` | estimated-contrast；选中态还必须有字重/图标变化 |

## 3. 字体排印

字体族无法从图片精确识别；实现固定使用现有系统字体栈。source 为 `screenshot-estimated`，strictness 为 `recommended`。

| 语义角色 | 字体族 | 字号 | 字重 | 行高 | 颜色 Token | Confidence |
|---|---|---:|---:|---:|---|---:|
| 文档标题 `h1` | 现有 system stack | 40px 参考；实现 32px | 700 参考；实现 650 | 1.2–1.25 | `color.ink` | 0.86 |
| 浏览器标题 `h2` | system stack | 27px 参考；实现 22px | 700 | 1.25 | `color.ink` | 0.84 |
| 品牌/导航强调 | system stack | 17–20px | 600–650 | 1.35 | `color.ink` | 0.82 |
| 正文/树节点 | system stack | 15–17px | 400–600 | 1.45 | `color.ink` | 0.80 |
| 元数据/辅助 | system stack | 12–14px | 400–500 | 1.4 | `color.muted` | 0.76 |

说明：截图比例对应展示稿，直接采用 40px 标题会破坏当前 900px 阅读宽度与移动端节奏；EasyNote 既有 `32px/27px` 标题是实现上限，属于仓库事实覆盖截图估算。

## 4. 间距系统

- **基础单位**: `4px`（source: `screenshot-inferred`, confidence: `0.86`, strictness: `recommended`）
- **内边距模式**: 8/12px 控件；16/20px 面板；32/40px 文档边距。
- **外边距模式**: 2–8px 紧凑控件间距；12–16px 组间距；24–32px 文档层级间距。
- **网格**: 桌面三栏，栏间 1px hairline；浮层锚定触发器而非视口绝对坐标。

| 间距 Token | 值 | 用途 | Source | Confidence | Strictness |
|---|---:|---|---|---:|---|
| `spacing.1` | 4px | 图标/文本微间距 | screenshot-inferred | 0.88 | recommended |
| `spacing.2` | 8px | 控件内距、紧凑行间距 | screenshot-inferred | 0.90 | recommended |
| `spacing.3` | 12px | 工具栏与行内距 | screenshot-inferred | 0.86 | recommended |
| `spacing.4` | 16px | 面板组间距 | screenshot-inferred | 0.85 | recommended |
| `spacing.5` | 20px | 左右栏主内距 | screenshot-estimated | 0.78 | flexible |
| `spacing.6` | 24px | 文档标题与元数据区节奏 | screenshot-estimated | 0.76 | recommended |
| `spacing.8` | 32px | 文档大区块 | screenshot-estimated | 0.74 | flexible |
| `spacing.10` | 40px | 桌面文档水平内距 | inferred-implementation | 0.96 | recommended |
