import type { HybridAgentBootstrapPayload, HybridGenerateParamsPayload } from '../../preload/index'

const DETAIL_HINTS: Record<0 | 1 | 2 | 3 | 4, { zh: string; en: string }> = {
  0: { zh: '最简略：仅模块骨架与进程签名', en: 'Skeleton: module shells and process signatures only' },
  1: { zh: '结构：类型、变量、ext', en: 'Structure: types, variables, ext' },
  2: { zh: '中等：自然语言 pre/post 大纲', en: 'Medium: natural-language pre/post outlines' },
  3: { zh: '较详细：场景拆分与异常路径', en: 'Detailed: scenarios and exceptional paths' },
  4: { zh: '最详细：GUI 视图/窗口/导航、不变量、模块间数据流', en: 'Full: GUI views/windows/navigation, invariants, inter-module flows' }
}

export function buildClientHybridAgentBootstrap(
  params: HybridGenerateParamsPayload
): HybridAgentBootstrapPayload {
  const zh = params.locale === 'zh-CN' || params.locale === 'zh-TW'
  const s = params.stages
  const detail = DETAIL_HINTS[params.detailLevel]
  const extras = [
    zh ? '## 生成参数（必须遵守）' : '## Generation parameters (mandatory)',
    zh
      ? `- 阶段：Hybrid Spec=${s.hybridSpec} 模块=${s.modules} 进程=${s.processes} 场景=${s.scenarios} 类型/变量=${s.typesVars !== false} 不变量=${s.invariants !== false} GUI=${Boolean(s.gui)}`
      : `- Stages: hybridSpec=${s.hybridSpec} modules=${s.modules} processes=${s.processes} scenarios=${s.scenarios} typesVars=${s.typesVars !== false} invariants=${s.invariants !== false} gui=${Boolean(s.gui)}`,
    zh ? `- 详细程度 ${params.detailLevel}/4：${detail.zh}` : `- Detail ${params.detailLevel}/4: ${detail.en}`,
    zh
      ? `- 已有 Hybrid 策略：${params.strategy === 'ask' ? '先询问用户' : params.strategy === 'merge' ? '合并并保留已有 pre/post' : '推倒重来'}`
      : `- Existing Hybrid strategy: ${params.strategy}`,
    zh
      ? `- 模块拆分：${params.moduleSplit === 'ask' ? '先询问' : params.moduleSplit === 'single-system' ? '单一 SYSTEM 模块' : '按功能聚类'}`
      : `- Module split: ${params.moduleSplit}`,
    zh
      ? `- 推断 Informal 未陈述的设计（窗口/视图/切换）：${params.inferUnstatedDesign ? '可以提案并标明假设' : '必须先提问'}`
      : `- Infer unstated design (windows/views/navigation): ${params.inferUnstatedDesign ? 'propose with stated assumptions' : 'ask first'}`
  ]
  if (s.hybridSpec) {
    extras.push(
      zh
        ? '- Hybrid Spec 全量：先划分 n 个模块（含 GUI 模块），再在各模块上生成进程与场景。'
        : '- Full Hybrid Spec: decompose into n modules (including a GUI module), then processes and scenarios per module.'
    )
  }
  return {
    skillId: 'hybrid-generation',
    title: zh ? '生成 Hybrid 规格' : 'Generate Hybrid Spec',
    initialUserMessage: zh
      ? '请根据当前 Informal 规格生成 Hybrid 规格。严格遵循注入的生成参数。先读取 Informal 与 Hybrid 库存，判断合并还是推倒重来，再按模块 → 进程 → 场景 → GUI 分阶段提出增量 patch，等待我确认后再继续。'
      : 'Generate a Hybrid Specification from the current Informal Specification. Follow the injected parameters. Read both inventories, decide merge vs rebuild, then propose incremental patches stage by stage (modules → processes → scenarios → GUI) and wait for confirmation.',
    promptExtras: extras.join('\n'),
    permissions: {
      informal: { read: true, write: false },
      hybrid: { read: true, write: true }
    }
  }
}
