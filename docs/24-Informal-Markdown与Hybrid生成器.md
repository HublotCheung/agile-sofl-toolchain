# Informal Specification（Markdown）与 Hybrid Generator

本文说明 Studio 当前 Informal 规格的数据模型、Markdown 源格式、AI Agent 边界，以及 Informal → Hybrid 的可插拔生成器接口。给后续接入研究算法的同学使用。

## 1. 核心原则

1. Informal Specification 是**结构化的自然语言规格**，不是 YAML。
2. Markdown 只是用户可读的序列化；`InformalSpecification` 才是数据核心。
3. AI 只能产出 **Patch**，必须经过 Preview → 用户确认 → Apply。
4. Hybrid 的 Code View 与 Visual View 共同操作 Hybrid Model（`.asfl` + editor-api DTO）。
5. Informal → Hybrid 必须走 `HybridSpecGenerator`，并保留 Traceability。

## 2. 源文件

- 扩展名仍为 `.aspec`（项目配对逻辑不变）。
- **主格式**：Markdown-like，固定一级标题：

```markdown
# Functions
# Data Resources
# Constraints
```

- 节内从 `##` 起，每深一层多一个 `#`。Function、Data Resource、Constraint 都可以任意嵌套；Data Resource 的下级是 field，field 还可以继续嵌套。超过六个 `#` 仍然是本格式的标题。

- 节点 ID 由标题派生，**不**写进用户 Markdown。旧文件里的 `<!-- @id:... -->` 仍可解析，打开时会从编辑器中去掉。
- 规格元信息（`id` / `moduleId` / `title` / `hybridTarget` / `guiTarget`）放在项目内部文件 `.agile-sofl/informal-meta.json`，**不要**写进用户编辑的 `.aspec`。
- 旧 YAML `.aspec` 仍可解析（兼容）。旧 Markdown 若带 YAML frontmatter，打开时会迁到 sidecar 并从编辑器中去掉。
- Studio 新建项目默认写出无 frontmatter 的 Markdown。

示例：`packages/studio/public/templates/atm-informal.aspec`、`examples/atm-informal.aspec`。

## 3. Domain API（`@agile-sofl/aspec`）

```ts
import {
  parseInformalSpec,
  serializeInformalSpec,
  applyInformalPatch,
  patchInformalSource,
  detectAspecFormat,
  ruleBasedHybridGenerator,
  createLlmHybridGenerator,
  registerHybridGenerator
} from '@agile-sofl/aspec'
```

- `parse(serialize(model))` 保持 ID 与层级。
- 一级标题不在 schema 内会报 `ASPEC_MD_001`。
- YAML 文档仍走 `parseAspec` → 合成 `AspecDocument`，供旧 refine / coverage 使用。

## 4. HybridSpecGenerator 插件

Studio 点击「生成 Hybrid」会发出生成事件，payload 为 Informal 模型 + `HybridGenerateParams`。Dispatcher 按 `runtime` 分流：

- `batch`（如 `rule-based`）：`generate(input, context)` → IR → `asflText`，对话框预览后 Apply（写入全局撤销栈）。
- `agent`（如 `llm-baseline`）：不一次性吐整份 SOFL；`agentBootstrap(request)` 在规格智能体中开新会话（Informal 只读、Hybrid 读写），由 agent 分阶段 `propose_hybrid_changes`。

```ts
interface HybridSpecGenerator {
  id: string
  name: string
  runtime?: 'batch' | 'agent'  // 默认 batch
  generate(
    input: InformalSpecification,
    context: GenerationContext
  ): Promise<HybridGenerationResult>
  agentBootstrap?(request: HybridGenerateRequest): HybridAgentBootstrap
}
```

`HybridGenerateParams`：

- `stages`：`hybridSpec`（默认勾选，强制模块/进程/场景）以及可选 typesVars / invariants / gui
- `detailLevel`：0 骨架 … 4 GUI/不变量/模块间流
- `strategy`：`ask` | `merge` | `rebuild`
- `inferUnstatedDesign`：是否推断 Informal 未写的窗口/视图/切换
- `moduleSplit`：`ask` | `single-system` | `cluster-by-function`

`GenerationContext.scope`（`hybrid` | `module` | `process` | `scenario`）**已弃用**，由 `params.stages` 映射；`selectedNodeIds` 仍用于 batch Apply Selected。

Batch 返回：

- `specification`: Hybrid IR
- `asflText`: SOFL `pre`/`post`（不是 `FSF :`）
- `traceLinks` / `changes` / `warnings`

LLM / agent **不得**直接覆盖 `.asfl`。Hybrid 增量编辑走 editor-api：`formatHybridInventory` / `applyHybridPatch`（稳定 id 如 `mod:ATM`、`proc:ATM.Withdraw`）。

### 内置生成器

| id | 名称 | runtime | 说明 |
|----|------|---------|------|
| `rule-based` | Rule-based Hybrid Generator | batch | 确定性映射：Function→process，Data→type/var，Constraint→inv |
| `llm-baseline` | LLM Hybrid Generator | agent | 注入 hybrid-generation skill，链式提问与 patch；`generate()` 仍可作为测试用 IR fallback |

### 注册自定义生成器

在 Studio 主进程（或你的研究包）中：

```ts
import { registerHybridGenerator, irToGenerationResult, type HybridSpecGenerator } from '@agile-sofl/aspec'

export const myGenerator: HybridSpecGenerator = {
  id: 'research-pattern-v1',
  name: 'Pattern-based Generator',
  async generate(input, context) {
    const ir = /* 你的算法 */
    return irToGenerationResult(input, ir)
  }
}

registerHybridGenerator(myGenerator)
```

不要：`Markdown → LLM → 整份 SOFL 文本` 直接覆盖文件。
应：`Informal Model → IR → Hybrid Model → SOFL 文本`。

Studio UI：Informal 列 **Generate Hybrid** 会列出已注册生成器。`llm-baseline` 会打开规格智能体会话；`rule-based` 仍预览 `asflText` 再写入 Hybrid 标签页（Ctrl+Z 可撤销）。

## 5. ChatECNU

- Base URL：`https://chat.ecnu.edu.cn/open/api/v1`
- 默认模型：`ecnu-max`
- Key：`packages/studio/.env` 的 `ECNU_API_KEY`（只在 Electron 主进程读取，不进渲染进程）
- 文档：[模型介绍](https://developer.ecnu.edu.cn/vitepress/llm/model.html)

## 6. Agent 工具

同一套规格智能体，会话创建时可配置 Informal / Hybrid 的读、写权限。默认对话（空状态直接输入）为 Informal + Hybrid 全读写；生成 Hybrid 的会话跳过对话框，权限为 Informal 只读 + Hybrid 读写。

Agent 使用 function calling，而不是自由改文件。工具按权限过滤：

- `ask_clarification`：选项 + 自定义输入卡片。已选答案再点其他选项时，询问是 fork 新对话还是覆盖原对话。
- 消息气泡可选中复制；底部提供「复制文字」「Fork 新对话」。
- `read_specification` / `propose_changes` / `review_specification`：Informal 库存与 patch（add / update / remove / move）。
- `read_hybrid_specification` / `propose_hybrid_changes` / `review_hybrid`：Hybrid 库存（`mod:` / `proc:` / `scn:` / `gui:`）与增量 patch。Apply 走全局撤销栈。
- skill `hybrid-generation`：模块 → 进程 → 场景 → GUI 链式推进；已有规格时先问 merge vs rebuild。

会话持久化：`<project>/.agile-sofl/agent/sessions/*.json`

## 7. 目录

```
packages/aspec/src/informal/     Markdown model / parser / serializer / patch
packages/aspec/src/generators/   HybridSpecGenerator + IR + params + rule/LLM baseline
packages/editor-api/src/hybrid*  Hybrid inventory / patch（agent CRUD）
packages/studio/src/main/services/llm/  ChatECNU + agent loop（权限过滤）
packages/studio/src/renderer/components/workspace/informal/
packages/studio/src/renderer/components/workspace/agent/
```
