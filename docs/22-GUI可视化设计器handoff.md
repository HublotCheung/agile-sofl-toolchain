# 22 — GUI 可视化设计器 handoff

本次交付把 YAML `.guispec` + 绝对定位画布换成 **受限 HTML DOM 结构编辑器 + 主题化原型 + 同屏规格动画**。

## 已交付

- 权威正文：`.gui.html`（白名单 HTML5 + `as-*` + `data-*`）；旧 YAML 在 parse 时迁移并丢弃 `bounds`
- 结构编辑器（`GuiDesignerCanvas.vue`）：左 DOM 树 / 调色盘，中主题化沙箱 iframe 原型，右 class 与 `data-process|bind|nav|scenario` 检查器
- Code Tab 直接编辑 `.gui.html`
- 原型 token 跟 Studio `:root` / `.dark`；不再默认强制 `.gui-preview-light`
- Run 模式：`data-process` → `deriveFsf` → 小求值或选场景 → mock 输出写回绑定
- Hybrid 只保留 `screen Name triggers Mod.Proc;`；`HybridGuiPanel` 不再改 widget 字符串
- Agent：`read_gui_specification` / `propose_gui_changes`（HTML 树补丁）

## 明确不做

- 不保留 YAML 为权威
- 不实现完整谓词解释器 / 译成 JS
- 原型脚本只允许内联 `<script type="text/as-logic">` 与少量事件属性，并且只在 `sandbox="allow-scripts"` 的 iframe 里执行，不能刷新 Studio 母页面。不开放自定义 CSS、外链脚本、`href` / `src`
- 不把 `propose_source_edit(replace-document)` 收成 GUI 唯一写路径

## 关键代码

| 位置 | 职责 |
|------|------|
| `packages/gui` | parse / sanitize / patch / inventory / `prototypeStylesheet` / `evalSimpleCondition` |
| `packages/studio/.../GuiPrototype.vue` | 沙箱 iframe 渲染、click/`data-nav`、受限逻辑脚本 |
| `packages/studio/.../GuiDesignerCanvas.vue` | DOM 树 + 检查器 + 动画侧栏 |
| `packages/studio/src/main/services/parseBridge.ts` | `studio:animate-gui-process`、hybrid 交叉校验 |
| `packages/parser` | 精简 `gui` 文法与 `validateGuiTriggers` |

演示路径：Login 填表 → `Auth.Login` 场景匹配/选择 → 写回 `out:` → `data-nav` 到 Dashboard。
