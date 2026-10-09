# Component Tree

## UI Type

- **值**: `application-dashboard`
- **组件树模型**: `three-pane-notebook-shell`

## 树形结构

```text
App [source: repository-existing]
└── NotebookShell [source: inferred-implementation]
    ├── NavigationRail [source: reference-visible]
    │   ├── BrandBlock [source: reference-visible]
    │   ├── CreateNoteAction [source: reference-visible]
    │   ├── PrimaryNavigation [source: reference-visible]
    │   ├── FolderSummary [source: reference-visible]
    │   ├── TagSummary [source: reference-visible]
    │   └── SettingsAction [source: reference-visible]
    ├── NotebookExplorer [source: reference-visible]
    │   ├── ExplorerHeader [source: reference-visible]
    │   ├── SearchField [source: reference-visible]
    │   └── ExplorerTree [source: reference-visible]
    │       ├── FolderTreeItem* [source: reference-visible]
    │       └── NoteTreeItem* [source: reference-visible]
    ├── PaneResizer [source: inferred-implementation]
    └── DocumentWorkspace [source: reference-visible]
        ├── WorkspaceToolbar [source: reference-visible]
        │   ├── SaveStatus [source: reference-visible]
        │   └── DocumentActions [source: reference-visible]
        ├── ErrorOrTrashBanner [source: repository-existing]
        ├── DocumentScroll [source: inferred-implementation]
        │   └── Document [source: reference-visible]
        │       ├── NoteTitle [source: reference-visible]
        │       ├── DocumentMetaBar [source: reference-visible]
        │       │   ├── FolderPicker [source: reference-visible]
        │       │   ├── TagPickerTrigger [source: reference-visible]
        │       │   └── Timestamp [source: reference-visible]
        │       └── EditorOrPreview [source: reference-visible]
        ├── KnowledgePanel? [source: repository-existing]
        └── DocumentFooter [source: repository-existing]
            └── TagPickerPopover? [source: reference-visible]
```

`*` 为重复节点，`?` 为条件渲染。`NotebookShell`、`DocumentScroll` 等没有独立视觉边界，因此仅是实现容器。

## 组件详情

### NavigationRail

- **Source**: reference-visible
- **bbox**: `34,47,238,993`
- **Evidence**: 品牌、主导航、文件夹/标签区、底部设置均位于同一浅灰栏
- **尺寸**: 参考 238px；生产 220px
- **背景**: `{color.sidebar}`
- **边框**: 右侧 `{color.line}` 1px
- **圆角**: 生产无独立圆角
- **内容类型**: 导航/按钮/计数
- **Confidence**: 0.97 high；strictness recommended

### NotebookExplorer

- **Source**: reference-visible
- **bbox**: `272,47,338,993`
- **Evidence**: “全部笔记”、搜索、文件夹与笔记层级树
- **尺寸**: 参考 338px；生产 300–440px
- **背景**: `{color.listPane}`
- **边框**: 右侧 `{color.line}` 1px
- **圆角**: 无
- **内容类型**: 搜索/树/上下文操作
- **Confidence**: 0.97 high；strictness required

### SearchField

- **Source**: reference-visible
- **bbox**: `294,140,293,47`
- **Evidence**: 搜索图标、占位文字、快捷键提示
- **尺寸**: 生产宽 100%，高 40px
- **背景**: `{color.soft}`
- **边框**: `{color.line}` 1px
- **圆角**: `{radius.control}`
- **阴影**: `{shadow.control}`
- **内容类型**: search input
- **Confidence**: 0.96 high；strictness recommended

### FolderTreeItem

- **Source**: reference-visible
- **bbox**: 代表行 `318,212,278,40`
- **Evidence**: disclosure arrow、蓝色文件夹、标题、行尾省略号
- **尺寸**: 高 40px；每层缩进 22px
- **背景**: transparent；hover `{color.hover}`
- **圆角**: `{radius.control}`
- **内容类型**: button/treeitem
- **Confidence**: 0.91 high；strictness recommended

### NoteTreeItem

- **Source**: reference-visible
- **bbox**: 选中行 `382,342,216,43`
- **Evidence**: 文档图标、标题、浅蓝选中面、更多操作
- **尺寸**: 生产高 38px
- **背景**: selected `{color.accentSoft}`
- **圆角**: `{radius.control}`
- **内容类型**: button/treeitem
- **Confidence**: 0.95 high；strictness recommended

### WorkspaceToolbar

- **Source**: reference-visible
- **bbox**: `610,47,804,90`
- **Evidence**: 横向保存状态、编辑/预览与操作图标、底部分隔线
- **尺寸**: 截图 90px；生产沿用 48px 紧凑工具栏
- **背景**: `{color.paper}`
- **边框**: bottom `{color.line}` 1px
- **圆角**: 无
- **内容类型**: status/actions
- **Confidence**: 0.96 high；strictness required

### SaveStatus

- **Source**: reference-visible
- **bbox**: `643,80,150,42`
- **Evidence**: 绿色勾图标及两行状态/时间
- **尺寸**: 生产单行优先，允许桌面两行；图标/状态点 16–24px
- **背景**: transparent
- **颜色**: success `{color.success}` + text `{color.muted}`
- **内容类型**: `role=status`
- **Confidence**: 0.94 high；strictness required

### Document

- **Source**: reference-visible
- **bbox**: `643,188,731,800`（内容可见区域估算）
- **Evidence**: 标题、元数据和大面积无卡片编辑画布
- **尺寸**: max-width 900px；wide 1080px
- **背景**: `{color.paper}`
- **边框/圆角/阴影**: none
- **内容类型**: editable document
- **Confidence**: 0.92 high；strictness required

### TagPickerPopover

- **Source**: reference-visible
- **bbox**: `870,310,306,480`
- **Evidence**: 带边框和阴影的浮层，含搜索、复选列表、新建标签
- **尺寸**: 生产 280px；max-height `min(420px,60dvh)`
- **背景**: `{color.elevated}`
- **边框**: `{color.line}`
- **圆角**: `{radius.panel}`
- **阴影**: `{shadow.panel}`
- **内容类型**: searchable multi-select popover
- **Confidence**: 0.97 high；strictness recommended

## 语义与键盘要求

- Explorer 使用嵌套 `<ul>/<li>` + buttons，或完整实现 WAI-ARIA Tree 键盘模型后才使用 `role=tree/treeitem`；禁止只加角色而无方向键行为。
- disclosure button 与打开项目 button 分离：左/右键仅在采用 tree pattern 时折叠/展开，Enter/Space 打开笔记。
- 行尾菜单必须能由 Tab 到达，且在 `:focus-within` 显示。
- TagPicker desktop 使用可定位 popover/details；Escape 关闭并把焦点还给触发器；mobile 使用 dialog bottom sheet。
- SaveStatus 保持 `role=status` 或 `aria-live=polite`，错误使用 `role=alert`。
