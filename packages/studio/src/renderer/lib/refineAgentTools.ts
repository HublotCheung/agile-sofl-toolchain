import type { HybridAgentBootstrapPayload } from '../../preload/index'
import type { Locale } from '../i18n'
import { useZhAgentCopy } from '../i18n'
import type { AtomicityRow } from './atomicityTree'

export type RefineAiToolId =
  | 'fill-empty-module'
  | 'fill-stub-process'
  | 'formalize-atoms'
  | 'complete-scenarios'
  | 'draft-cdfd'
  | 'decompose-process'
  | 'declare-atomic'
  | 'introduce-retrieve'
  | 'discharge-obligation'
  | 'resolve-grain'

export function refineToolsForRow(row: AtomicityRow): RefineAiToolId[] {
  if (!row.problem) return []
  if (row.kind === 'process-root') {
    return ['fill-empty-module', 'fill-stub-process', 'formalize-atoms', 'complete-scenarios', 'draft-cdfd']
  }
  if (row.kind === 'data-root') return ['introduce-retrieve', 'discharge-obligation']
  if (row.kind === 'gap' || row.isEmpty) return ['fill-empty-module', 'draft-cdfd']
  if (row.kind === 'data') {
    if (row.dataKind === 'obligation') return ['discharge-obligation']
    return ['introduce-retrieve']
  }
  if (row.kind === 'atom' || row.gateId === 'informal') return ['formalize-atoms']
  if (row.gateId === 'coverage') return ['complete-scenarios']
  if (row.gateId === 'cdfd') return ['draft-cdfd']
  if (row.gateId === 'types') return ['fill-stub-process']
  if (row.gateId === 'grain') return ['resolve-grain']
  if (row.kind === 'composite') return ['decompose-process', 'fill-empty-module', 'draft-cdfd']
  if (row.kind === 'leaf') {
    const tools: RefineAiToolId[] = []
    if (row.isStub) tools.push('fill-stub-process')
    if (row.status === 'ready') tools.push('declare-atomic')
    else tools.push('resolve-grain')
    tools.push('formalize-atoms', 'complete-scenarios', 'draft-cdfd', 'decompose-process')
    return [...new Set(tools)]
  }
  if (row.kind === 'module') return ['fill-empty-module', 'draft-cdfd']
  return []
}

export function buildRefineAgentBootstrap(
  tool: RefineAiToolId,
  row: AtomicityRow,
  locale: Locale
): HybridAgentBootstrapPayload {
  const zh = useZhAgentCopy(locale)
  const moduleName = row.moduleName ?? ''
  const processName = row.processName ?? ''
  const specs: Record<
    RefineAiToolId,
    { titleZh: string; titleEn: string; msgZh: string; msgEn: string; extraZh: string; extraEn: string }
  > = {
    'fill-empty-module': {
      titleZh: '补全空模块',
      titleEn: 'Fill empty module',
      msgZh: moduleName
        ? `请补全空模块「${moduleName}」：它目前只有模块名。对照 Informal 库存，用 propose_hybrid_changes 增加类型、变量、过程和场景。源码里没有成员不代表已完成，这是缺口。`
        : '请补全当前规格中所有空壳模块（只有模块名、无类型/变量/过程/CDFD）。没有定义不等于没有问题。',
      msgEn: moduleName
        ? `Fill empty module "${moduleName}": it is only a name. Add types, variables, processes and scenarios from Informal. Absence of members is a gap, not completeness.`
        : 'Fill every empty-shell module (name only, no types/vars/processes/CDFD). Missing definition is a gap.',
      extraZh: '空壳模块必须建模。优先 CRUD；需要 CDFD 时用 propose_refinement_step kind=SetCdfd。',
      extraEn: 'Empty shells must be modelled. Prefer CRUD; use SetCdfd when a diagram is needed.'
    },
    'fill-stub-process': {
      titleZh: '充实骨架过程',
      titleEn: 'Flesh out stub process',
      msgZh: processName
        ? `过程「${processName}」（模块 ${moduleName}）目前几乎只有名字。请写出真实输入/输出、pre/post 场景（含 others），并视需要画入 CDFD。仅声明名称不算完成。`
        : '请充实规格中所有骨架过程（只有过程名、没有 pre/post/分解）。仅声明方法名不算需求规格已完成。',
      msgEn: processName
        ? `Process "${processName}" in ${moduleName} is a stub. Write real ports, pre/post with others, and place it on the CDFD. A name-only declaration is not complete.`
        : 'Flesh out every stub process (name only, no pre/post/decom). A signature is not a finished specification.',
      extraZh: '用 replace-process-body（fsf 字段）或 propose_refinement_step；按终版语法写 FSF：FSF : T1 && D1 || T2 && D2 || … || others && Dn。',
      extraEn: 'Use replace-process-body (fsf field) or propose_refinement_step; write FSF in final-grammar form: FSF : T1 && D1 || T2 && D2 || … || others && Dn.'
    },
    'formalize-atoms': {
      titleZh: '形式化 informal 原子',
      titleEn: 'Formalize informal atoms',
      msgZh: processName
        ? `请将模块 ${moduleName} 过程「${processName}」中的 informal 谓词通过 propose_refinement_step kind=FormalizePredicate 形式化。fromText 必须与源码中的 informal 原文一致。`
        : '请形式化当前规格中尚未消除的 informal 谓词（FormalizePredicate）。fromText 必须与源码原文一致。',
      msgEn: processName
        ? `Formalize informal predicates on ${moduleName}.${processName} via FormalizePredicate. fromText must match the informal source text.`
        : 'Formalize remaining informal predicates via FormalizePredicate. fromText must match source.',
      extraZh: '禁止直接改字而不提交 FormalizePredicate，否则二义性计数不会下降。',
      extraEn: 'Do not silently replace informal text; ambiguity will not drop without FormalizePredicate.'
    },
    'complete-scenarios': {
      titleZh: '补全场景覆盖',
      titleEn: 'Complete scenario coverage',
      msgZh: processName
        ? `过程「${processName}」场景覆盖不完整。请补全 pre/post 划分，并确保有 others（或等价 else）路径。`
        : '请补全场景覆盖不完整的过程：划分 pre/post，并保证 others/else 路径。',
      msgEn: processName
        ? `Scenario coverage for "${processName}" is incomplete. Add partitions and an others/else path.`
        : 'Complete scenario coverage for incomplete processes, including an others/else path.',
      extraZh: '形式场景后可用 DeclareAtomic；尚未结构原子时不要 DeclareAtomic。',
      extraEn: 'DeclareAtomic only after the process is structurally atomic.'
    },
    'draft-cdfd': {
      titleZh: '生成 CDFD',
      titleEn: 'Draft CDFD',
      msgZh: moduleName
        ? `为模块「${moduleName}」生成或补全 cdfd：port/store/node/cond/flow，过程都要出现在 node 上，边界流平衡。旧文件可以没有 cdfd，但这次是用户明确要求绘制。`
        : '请为仍缺 CDFD、或过程未上图的模块生成 cdfd（port/store/node/cond/flow）。用户这次明确要求绘制。',
      msgEn: moduleName
        ? `Write or complete the cdfd for module "${moduleName}" (port/store/node/cond/flow). Every process must appear as a node; balance boundary flows.`
        : 'Draft CDFDs for modules that still need diagrams. Every process must appear as a node.',
      extraZh: '使用 propose_refinement_step kind=SetCdfd，toText 为一整个 cdfd…end_cdfd。不要写坐标。',
      extraEn: 'Use SetCdfd with a full cdfd…end_cdfd block. No coordinates.'
    },
    'decompose-process': {
      titleZh: '分解过程',
      titleEn: 'Decompose process',
      msgZh: processName
        ? `将过程「${processName}」分解为子模块（DecomposeProcess），并在子模块 CDFD 中展开子过程。`
        : '请将仍过于粗的过程分解为子模块，并在子模块 CDFD 中展开。',
      msgEn: processName
        ? `Decompose process "${processName}" into a child module and expand its CDFD.`
        : 'Decompose coarse processes into child modules and expand their CDFDs.',
      extraZh: 'kind=DecomposeProcess，提供 childModuleName。随后在子模块里补过程与流。',
      extraEn: 'kind=DecomposeProcess with childModuleName, then add child processes and flows.'
    },
    'declare-atomic': {
      titleZh: '声明原子过程',
      titleEn: 'Declare atomic',
      msgZh: processName
        ? `过程「${processName}」的形式闸门和操作粒度都已闭合。请提交 propose_refinement_step kind=DeclareAtomic（模块 ${moduleName}）。`
        : '请为已同时满足形式原子与操作原子、尚未 DeclareAtomic 的过程提交声明。',
      msgEn: processName
        ? `Process "${processName}" is formally and operationally atomic. Submit DeclareAtomic for module ${moduleName}.`
        : 'Submit DeclareAtomic only for processes that are both formally and operationally atomic.',
      extraZh: '不要改源码，只记账。形式闸门和操作粒度都闭合后才能 DeclareAtomic。',
      extraEn: 'Journal only. DeclareAtomic requires both the formal gates and operational grain to be closed.'
    },
    'resolve-grain': {
      titleZh: '闭合操作粒度',
      titleEn: 'Close operational grain',
      msgZh: processName
        ? `过程「${processName}」（模块 ${moduleName}）的操作粒度尚未闭合。先 read_refinement_state，只针对摘要里已经抽出的变体（以及 name-claim）用 ask_clarification 让用户判定：收窄为当前这一种效果并改名、标成同一操作的场景、拆成子过程，或豁免。确认后再提交 ClassifyGrain 或 ResolveVariation。`
        : '请对粒度未闭合的叶子过程，用 ask_clarification 判定摘要中已抽出的变体，再提交 ClassifyGrain 或 ResolveVariation。',
      msgEn: processName
        ? `Operational grain for "${processName}" in ${moduleName} is still open. Read the refinement digest and ask_clarification only about variations already extracted (and name-claim). Then submit ClassifyGrain or ResolveVariation.`
        : 'For leaves whose grain is open, ask_clarification about extracted variations, then ClassifyGrain or ResolveVariation.',
      extraZh:
        '禁止靠改写 pre/post 把 grainAmbiguity 清零；没有 ClassifyGrain / ResolveVariation / DecomposeProcess，粒度计数不会下降。不要发明摘要里没有的操作。variationId 使用摘要中的 id；豁免名称用 variationId=name-claim 且 disposition=waived，并在 note 里写理由。子过程用 disposition=child 且 toText 为子过程名。',
      extraEn:
        'Do not zero grainAmbiguity by rewriting pre/post. The counter stays until ClassifyGrain, ResolveVariation, or DecomposeProcess. Do not invent operations that are not in the digest. Use the extracted variation id; waive a broad name with variationId=name-claim, disposition=waived, and a note. A child uses disposition=child and toText=child process name.'
    },
    'introduce-retrieve': {
      titleZh: '引入 retrieve',
      titleEn: 'Introduce retrieve',
      msgZh: row.label && row.kind === 'data'
        ? `针对数据项「${row.label}」完成数据精化：DefineType 或 IntroduceRetrieve（表示类型 + retrieve 函数体）。`
        : '请为尚未精化的 given 类型引入表示类型与 retrieve 函数。',
      msgEn: row.label && row.kind === 'data'
        ? `For data item "${row.label}", introduce a retrieve (representation type + retrieve body) or define the type.`
        : 'Introduce representation types and retrieve functions for open given types.',
      extraZh: 'kind=IntroduceRetrieve 或 DefineType。given 类型必须被精化。',
      extraEn: 'kind=IntroduceRetrieve or DefineType. given types must be refined.'
    },
    'discharge-obligation': {
      titleZh: '释放数据义务',
      titleEn: 'Discharge data obligation',
      msgZh: row.label && row.kind === 'data'
        ? `数据精化义务「${row.label}」仍开放。请审查 retrieve 后提交 DischargeDataObligation。`
        : '请审查尚未释放的数据精化义务，审查通过后提交 DischargeDataObligation。',
      msgEn: row.label && row.kind === 'data'
        ? `Data obligation "${row.label}" is still open. Review the retrieve, then DischargeDataObligation.`
        : 'Review open data-refinement obligations and DischargeDataObligation after review.',
      extraZh: '本阶段无定理证明器；kind=DischargeDataObligation 表示人工审查通过。',
      extraEn: 'No prover in this phase; DischargeDataObligation means reviewed by hand.'
    }
  }

  const spec = specs[tool]
  return {
    skillId: 'hybrid-refinement',
    title: zh ? spec.titleZh : spec.titleEn,
    initialUserMessage: zh ? spec.msgZh : spec.msgEn,
    promptExtras: [
      zh ? '## 精化工具约束' : '## Refinement tool constraints',
      zh ? spec.extraZh : spec.extraEn,
      zh
        ? '- 优先 propose_refinement_step；需要增补声明时用 propose_hybrid_changes。空模块和骨架过程计入未完成，不能因为没写就不算问题。'
        : '- Prefer propose_refinement_step; use propose_hybrid_changes for new declarations. Empty modules and stub processes are gaps.'
    ].join('\n'),
    permissions: {
      informal: { read: true, write: false },
      hybrid: { read: true, write: true }
    }
  }
}
