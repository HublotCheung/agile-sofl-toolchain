# Agile-SOFL 文档索引

本目录是自包含的中文设计与使用文档，介绍 **Agile-SOFL** 语言及本解析器库的实现。所有文法、示例与语义规则均直接写在文档中，可直接复制 `.asfl` 片段运行验证。

## 阅读顺序

| 文档 | 内容 |
|------|------|
| [01-Agile-SOFL-介绍.md](./01-Agile-SOFL-介绍.md) | 动机、与经典 SOFL 的关系、典型开发流程 |
| [02-语言概览.md](./02-语言概览.md) | 规格结构、各段语法、完整 Banking 示例走读 |
| [03-文法参考.md](./03-文法参考.md) | 完整 EBNF、词法规则、正例 |
| [04-类型与表达式.md](./04-类型与表达式.md) | 类型构造、表达式优先级、量词与条件式 |
| [05-FSF-规约.md](./05-FSF-规约.md) | 场景规约、others 分支、形式/半形式判定 |
| [06-解析器与AST设计.md](./06-解析器与AST设计.md) | 流水线、AST 节点、Span、诊断码 |
| [07-语义分析.md](./07-语义分析.md) | 符号表、类型检查、FSF 分类、信息隐藏 |
| [08-API与CLI.md](./08-API与CLI.md) | `parse` / `check` / `inspect` / REPL 用法 |
| [09-测试与贡献.md](./09-测试与贡献.md) | 跑测试、加 fixture、本地验证 |
| [10-编辑器路线图.md](./10-编辑器路线图.md) | LSP 架构与后续能力规划 |
| [11-VSCode扩展与LSP.md](./11-VSCode扩展与LSP.md) | VS Code/Cursor 扩展（私有 VSIX 安装、开发与打包发版） |
| [12-Electron编辑器集成.md](./12-Electron编辑器集成.md) | Electron / Studio 架构与 npm 集成 |
| [13-模块边界与仓库结构.md](./13-模块边界与仓库结构.md) | Monorepo 包布局与依赖边界 |
| [14-Studio-UI设计规约.md](./14-Studio-UI设计规约.md) | Studio 桌面编辑器 UI 设计 token 与组件规约 |
| [15-Studio可视化编辑器.md](./15-Studio可视化编辑器.md) | Studio 可视化编辑架构与同步协议 |
| [16-Studio可视化编辑器迭代.md](./16-Studio可视化编辑器迭代.md) | Studio 各阶段迭代记录 |
| [17-Informal与Hybrid规格编辑器设计.md](./17-Informal与Hybrid规格编辑器设计.md) | Task 1：`.aspec` 非形式规格（含 `bookAlign` 著作对齐块）、精化/traceability、双文档编辑器 |
| [18-GUI规格模块设计.md](./18-GUI规格模块设计.md) | `.guispec` / 内嵌 GUI、线框预览、与 informal 的追踪 |
| [19-ASFL-GUI文法扩展.md](./19-ASFL-GUI文法扩展.md) | Hybrid `.asfl` 内 `gui` 块文法、诊断与精化映射 |
| [20-工作进度与演进方向.md](./20-工作进度与演进方向.md) | 通俗总览：Parser / 语法 / Hybrid 编辑与维护 / AI 渐进形式化 |
| [21-Informal-IDE接口与handoff.md](./21-Informal-IDE接口与handoff.md) | Informal 列 Phase 1 纯文本与后续 IDE/AI 扩展点 |
| [22-GUI可视化设计器handoff.md](./22-GUI可视化设计器handoff.md) | WinForms 风格 GUI 设计器已交付能力与后续缺口 |
| [23-Hybrid规格IDE接口.md](./23-Hybrid规格IDE接口.md) | Hybrid 自然语言骨架、AssistantProvider、左树右键注册表 |
| [24-Informal-Markdown与Hybrid生成器.md](./24-Informal-Markdown与Hybrid生成器.md) | Markdown Informal 模型、AI Agent、可插拔 Hybrid Generator |
| [25-原子需求与精化度量机制.md](./25-原子需求与精化度量机制.md) | 原子需求、双线精化、二义性计数、审计步骤、CDFD/场景分工（科研/论文） |

| [26-Trace关联与双向联动.md](./26-Trace关联与双向联动.md) | 关联恢复、双向建议、稳定身份、影响检测与后续演进设计 |
| [27-Trace演示与组会讲解.md](./27-Trace演示与组会讲解.md) | 演示准备、逐步操作、组会讲稿与常见问答 |

## 快速验证

```bash
npm install && npm run build
npx asfl inspect tests/fixtures/integration/banking.asfl
npx asfl repl
npm test
```

## 版本说明

文档描述的是**当前解析器实际支持**的语言子集。若某高级特性尚未实现，会在 [03-文法参考.md](./03-文法参考.md) 中标注「当前版本支持范围」。
