export type AgentSkillId =
  | 'requirement-discovery'
  | 'requirement-clarification'
  | 'function-decomposition'
  | 'data-modeling'
  | 'constraint-discovery'
  | 'specification-review'
  | 'hybrid-generation'
  | 'hybrid-refinement'

export const AGENT_SKILLS: Array<{ id: AgentSkillId; name: string; prompt: string }> = [
  {
    id: 'requirement-discovery',
    name: 'Requirement Discovery',
    prompt:
      'Discover Functions, Data Resources, and Constraints from the user\'s natural language. Do not dump a full specification. Summarize candidates, then ask clarifying questions, then propose structured propose_changes patches. After each applied write, read_specification and continue until the inventory is complete, then summarize. If CRUD cannot express a fix, read view=source and propose_source_edit. The full journey is Informal → Hybrid+GUI → dual-line refinement until the refinement digest is unambiguous. If Hybrid already exists with remaining gaps, after Informal work call read_refinement_state and invite the next refinement slice — do not stop as if the specification were finished.'
  },
  {
    id: 'requirement-clarification',
    name: 'Requirement Clarification',
    prompt:
      'Find vague, missing, or ambiguous information. Ask focused questions (options + optional custom input) via ask_clarification. When a stakeholder choice is unresolved (threshold, permission/role scope, policy boundary, capacity limit, open course-assignment or export scope, undecided allow/deny rule), ask before writing that concrete value into the specification. If the requirement names a policy without defining it (e.g. \'according to the course assignment policy\'), that is an open policy slot: call ask_clarification before proposing any concrete allow/deny default. Do not invent details the user did not confirm.'
  },
  {
    id: 'function-decomposition',
    name: 'Function Decomposition',
    prompt:
      'Decompose a selected function into sub-steps. Propose child function nodes, not free-form markdown.'
  },
  {
    id: 'data-modeling',
    name: 'Data Modeling',
    prompt:
      'Identify data resources and fields. Propose data-resource / data-field nodes with clear titles and short descriptions.'
  },
  {
    id: 'constraint-discovery',
    name: 'Constraint Discovery',
    prompt:
      'Turn business rules into Constraint nodes with precise natural-language statements (limits, locking, non-negativity, uniqueness).'
  },
  {
    id: 'specification-review',
    name: 'Specification Review',
    prompt:
      'Review Completeness, Precision, Consistency, and Traceability. Call review_specification and list concrete issues tied to node ids when possible.'
  },
  {
    id: 'hybrid-generation',
    name: 'Hybrid Generation',
    prompt: `Turn Informal Specification into Hybrid (.asfl) incrementally via CRUD tools. NEVER dump a full SOFL file or use replace-document.
Agile-SOFL architecture:
- Exactly one top-level SYSTEM_ module named after the whole system (e.g. SYSTEM_FoodDelivery). It is the system module; other modules are children (module Auth / FoodDelivery;).
- Add SYSTEM_ first (it is inserted at the file start). Then add semantic modules with parentId=mod:SYSTEM_…. A GUI_ module is a child, not the system module.
- Process signatures default to () when ports are unknown. Never invent dummy (x: nat) ok: nat. Write real inputs/outputs when they exist. There is no implication operator; write not A or B.
Stakeholder decisions:
- If a threshold, permission/role scope, policy boundary, capacity limit, open course-assignment/export scope, undecided allow/deny rule, or other stakeholder choice is unresolved in the task, call ask_clarification before writing that concrete value into Informal or Hybrid.
- An open policy/scope slot includes phrases like "according to the X policy" or "per assignment policy" when X is not defined: you MUST call ask_clarification before propose_hybrid_changes / replace-process-body writes any concrete allow/deny default (e.g. assigned=true allows, assigned=false denies).
- Until answered, do not invent defaults for those parameters and do not treat silence as approval of a specific number, role, scope, or allow/deny mapping.
- After an answer, apply only what was confirmed; ask again if another distinct stakeholder choice remains open.
Pipeline — keep going after each applied patch until every enabled stage is done, then summarize:
1. Read Informal and Hybrid inventories. If Hybrid already exists and strategy is ask, call ask_clarification (merge vs rebuild).
2. Module architecture: add the SYSTEM_ module, then each semantic module (and a GUI module) with propose_hybrid_changes op=add kind=module. Do not paste module source.
3. Per module: add types/variables from Data Resources (kind=type|var, parentId=mod:…).
4. Per module: add process signatures from Functions (kind=process).
5. Per process: replace-process-body or add scenarios. Write the FSF (FSF : T1 && D1 || T2 && D2 || … || others && Dn); Ti/Di may be structured natural language at this stage. Enumerations use {<Tag>}.
6. Add invariants (kind=inv) from Constraints. One predicate per inv op; use ASFL syntax only: forall[u: Type] | expr; (not "forall u: Type,"). No iff — use (A implies B) and (B implies A). traceLinks target invariants as inv:Module.0 (zero-based index from inventory, not a slug). Do NOT dump GUI widgets into Hybrid CRUD.
7. For UI, call read_gui_specification then propose_gui_changes. Each screen is its own HTML page (data-screen) with data-nav to sibling screens so the prototype can click-switch. ONE screen per call — a multi-screen payload is truncated and rejected. Build a high-fidelity HTML prototype (shell, sidebar, hero, cards, forms, lists, empty states) — not a page of three buttons. Use whitelist tags plus any as-* class. Bind with data-process / data-bind / data-nav. Prefer replace-screen-html with the full inner layout of that one screen. Inline <script type="text/as-logic"> may compute or animate inside that screen (price ticks, counters); it cannot reload the host app. Hybrid gui blocks stay as slim screen→process traces.
After every applied write, call read_hybrid_specification / read_gui_specification and fix gaps until inventories are correct.
8. Three-line refinement is a later stage, not automatic. After enabled Hybrid/GUI stages finish, call read_refinement_state. If unambiguous=false, ask_clarification with 2–4 next slices (empty module, stub process, FormalizePredicate, data retrieve, operational grain). Do not refine the entire tree in one go. Do not claim the specification has no ambiguity while empty modules, stubs, processAmbiguity, dataAmbiguity, or grainAmbiguity remain. Grain questions may only use variations already listed in the digest.
Last message = summary of completed generation stages plus remaining refinement gaps.
If CRUD fails, the file is empty/out of sync, diagnostics list syntax errors, or leftover unparsed text appears, call read_hybrid_specification with view=source then propose_source_edit (unique replace/append/replace-document). Do not retry the same failing CRUD. Prefer CRUD; source edit is last resort.
Infer unstated GUI/navigation only when the parameter allows it; otherwise ask. Prefer small patches citing inventory ids.`
  },
  {
    id: 'hybrid-refinement',
    name: 'Hybrid Refinement',
    prompt: `You are refining an existing Hybrid (.asfl) specification along three lines: process atomicity, data refinement, and operational grain. Do not dump a full file. Formal pre/post does not make a process one operation.
Completeness is not "whatever happens to be written". A module that is only a name (no types/vars/processes/cdfd) is an empty shell — a gap. A process that is only a name (no pre/post/fsf/decom) is a stub — also a gap.
Guide the user one slice at a time. Do not silently refine every node.
If a stakeholder choice (threshold, permission/role scope, policy boundary, capacity, open course-assignment/export scope, undecided allow/deny) is unresolved, ask_clarification before writing that concrete value into the Hybrid. Do not silently hard-code allow/deny defaults for an undefined policy via propose_hybrid_changes.
Pipeline:
1. read_refinement_state (tree or summary) plus Informal/Hybrid inventories. Identify the named module/process/data item from the user message, or ask_clarification if several slices are open.
2. Prefer propose_refinement_step: FormalizePredicate, DecomposeProcess, SetCdfd, DeclareAtomic, IntroduceRetrieve, DischargeDataObligation, DefineType, ClassifyGrain, ResolveVariation.
   Grain: read the digest. ask_clarification only about variations already extracted (and name-claim). Then ClassifyGrain (grainClass=operation|abstract) or ResolveVariation (variationId, disposition=scenario|child|waived, toText=child process name, note required when waived). Do not invent a CRUD catalog. Do not clear grainAmbiguity by rewriting pre/post; that counter drops only after those steps or DecomposeProcess. DeclareAtomic requires operational grain to be closed.
3. Use propose_hybrid_changes for new types/vars/processes/scenarios when the shell is empty. Include traceLinks with exact Informal sourceId and fully qualified Hybrid targetId for every derived node. Provenance is mandatory for new semantic nodes: it is validated and committed together with the modeling operation, without a separate user link review. Existing nodes keep their stable bindings; scenarios and referenced declarations may inherit their process provenance. If validation reports missing provenance, repair the tool call yourself using read_specification inventory and retry; never ask the user to manage links. Never treat missing members as done.
4. If CRUD/refinement-step cannot express the fix, read_hybrid_specification view=source then propose_source_edit (replace/append). Informal atoms still need a FormalizePredicate step afterwards or ambiguity will not drop.
5. CDFD is optional on old files; write one only when the user asks to draft/complete a diagram or a process must appear on the current module graph.
6. After each applied write, read_refinement_state. Stay on the chosen slice until that local gap shrinks. Then if more gaps remain, ask_clarification for the next slice — do not claim an unambiguous spec while the digest says unambiguous=false.
Last message = what ambiguity dropped (process vs data vs grain) and what remains.`
  }
]

export function skillById(id?: string) {
  return AGENT_SKILLS.find((s) => s.id === id) ?? AGENT_SKILLS[0]!
}

export const AGENT_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'ask_clarification',
      description:
        'Ask the user a structured clarification question when a stakeholder decision is needed (threshold, permission/role scope, policy boundary, capacity, open course-assignment/export scope, undecided allow/deny, merge vs rebuild, next refinement slice). The UI renders options plus a custom text field. The tool result has selected (clicked options) and custom (text the user typed). A non-empty custom answer is required context for both single-choice and multi-choice, even when selected is also set. Never ignore custom. Do not invent those concrete values in the specification before this tool returns — especially do not write allow/deny defaults for an undefined policy via propose_hybrid_changes first. Use this instead of listing questions only in prose when a decision is needed.',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string' },
          options: {
            type: 'array',
            items: {
              type: 'object',
              properties: { id: { type: 'string' }, label: { type: 'string' } },
              required: ['id', 'label']
            }
          },
          allowCustom: { type: 'boolean' },
          multiSelect: { type: 'boolean' }
        },
        required: ['question']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'propose_changes',
      description:
        'Propose a structured Informal Specification patch against the CURRENT Informal inventory ids. Never write raw markdown. Never use this for Hybrid/.asfl. Prefer update/remove on existing ids. After Apply (or auto-write), continue: read_specification, fix gaps, then summarize.',
      parameters: {
        type: 'object',
        properties: {
          explanation: { type: 'string' },
          operations: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                op: { type: 'string', enum: ['add', 'update', 'remove', 'move'] },
                target: {
                  type: 'string',
                  description:
                    'add only: functions | data-resources | constraints, or a parent node id. Depth is unlimited.'
                },
                id: {
                  type: 'string',
                  description: 'update / remove / move: existing node id from the inventory (or unique title).'
                },
                parentId: { type: 'string' },
                afterId: { type: 'string' },
                title: { type: 'string', description: 'update: new title' },
                description: { type: 'string', description: 'update: new body text' },
                node: {
                  type: 'object',
                  properties: {
                    type: {
                      type: 'string',
                      enum: ['function', 'data-resource', 'data-field', 'constraint', 'text']
                    },
                    title: { type: 'string' },
                    description: { type: 'string' },
                    children: {
                      type: 'array',
                      description: 'Optional nested nodes. Each item repeats type, title, description, and children.',
                      items: { type: 'object' }
                    }
                  }
                }
              },
              required: ['op']
            }
          }
        },
        required: ['operations']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'read_specification',
      description:
        'Return the current Informal Specification. Default view=inventory (node ids/titles). Pass view=source for numbered markdown text before propose_source_edit. Does not return Hybrid/.asfl.',
      parameters: {
        type: 'object',
        properties: {
          view: {
            type: 'string',
            enum: ['inventory', 'source'],
            description: 'inventory (default) or numbered source text'
          }
        }
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'review_specification',
      description: 'Record a structured review of the current informal specification.',
      parameters: {
        type: 'object',
        properties: {
          issues: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                dimension: {
                  type: 'string',
                  enum: ['completeness', 'precision', 'consistency', 'traceability']
                },
                message: { type: 'string' },
                nodeId: { type: 'string' }
              },
              required: ['dimension', 'message']
            }
          }
        },
        required: ['issues']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'read_hybrid_specification',
      description:
        'Return the current Hybrid Specification. Default view=inventory (mod:/proc:/scn:/type:/var:/inv:/gui:) plus per-module syntax/parse diagnostics when present. Pass view=source for numbered .asfl text before propose_source_edit. Always inspect diagnostics and fix remaining errors.',
      parameters: {
        type: 'object',
        properties: {
          view: {
            type: 'string',
            enum: ['inventory', 'source'],
            description: 'inventory (default) or numbered source text'
          }
        }
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'read_refinement_state',
      description:
        'Return the current dual-line refinement digest (Liu SOFL process atomicity + data discharge): overall harmonic completeness, empty-shell modules, stub processes, informal atoms, open scenarios, data obligations, and a process/data tree. Call this after Hybrid writes. view=summary (default), tree, or log. Missing members are gaps, not completeness.',
      parameters: {
        type: 'object',
        properties: {
          view: {
            type: 'string',
            enum: ['summary', 'tree', 'log'],
            description: 'summary (counters + next slices), tree (modules/processes/gates/data), or audit log'
          }
        }
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'propose_hybrid_changes',
      description:
        'Propose an incremental Hybrid/.asfl CRUD patch against inventory ids (mod:, proc:Module.Name). Prefer this over source edits. SYSTEM_ is the unique top-level system module (named after the whole system) and is inserted first; other modules use parentId=mod:SYSTEM_…. Default process signature is (). Never emit raw SOFL or replace-document here. Use add/update/remove/replace-process-body. Write process logic as FSF via replace-process-body.fsf: FSF : T1 && D1 || T2 && D2 || … || others && Dn. There is no implication operator; write not A or B. If the task leaves an open policy/scope slot (undefined course-assignment policy, unresolved role/export scope, undecided allow/deny), call ask_clarification first; do not write concrete allow/deny defaults into FSF until answered.',
      parameters: {
        type: 'object',
        properties: {
          explanation: { type: 'string' },
          traceLinks: {
            type: 'array',
            description: 'Required provenance for new semantic nodes. Include exact Informal source inventory IDs and fully qualified target IDs from the inventory (proc:Module.Name, type:Module.Name, var:Module.Name, const:Module.Name, fn:Module.Name, inv:Module.zeroBasedIndex). Modules (mod:) are scaffolding and need no link. Every new type/var/const declared in the same patch needs its own link unless a new linked process references it. Existing bindings are preserved; use [] only for edits to already bound nodes or module scaffolding. Source and bindings are applied together.',
            items: { type: 'object', properties: { sourceId: { type: 'string' }, targetId: { type: 'string' }, relation: { type: 'string', enum: ['refines', 'constrains', 'uses'] } }, required: ['sourceId', 'targetId'] }
          },
          operations: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                op: {
                  type: 'string',
                  enum: ['add', 'update', 'remove', 'replace-process-body']
                },
                kind: {
                  type: 'string',
                  enum: [
                    'module',
                    'process',
                    'function',
                    'type',
                    'var',
                    'const',
                    'inv',
                    'scenario',
                    'gui-screen'
                  ]
                },
                id: { type: 'string', description: 'update/remove/replace-process-body: inventory id' },
                parentId: { type: 'string', description: 'add: parent mod: or proc: id' },
                name: { type: 'string' },
                text: { type: 'string' },
                fsf: { type: 'string', description: 'replace-process-body: final-grammar FSF "FSF : T1 && D1 || T2 && D2 || … || others && Dn"' },
                pre: { type: 'string' },
                post: { type: 'string' },
                signature: { type: 'string' },
                comment: { type: 'string' },
                scenarios: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      name: { type: 'string' },
                      guard: { type: 'string' },
                      test: { type: 'string' },
                      def: { type: 'string' },
                      definingCondition: { type: 'string' },
                      kind: { type: 'string', enum: ['normal', 'exceptional'] }
                    }
                  }
                }
              },
              required: ['op']
            }
          }
        },
        required: ['operations']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'read_gui_specification',
      description:
        'Read the current GUI HTML specification. view=inventory lists screens plus a DOM outline of layout/widgets/bindings; view=source returns numbered .gui.html. Use whitelist tags and as-* classes. Design complete product screens, not a few isolated buttons.',
      parameters: {
        type: 'object',
        properties: {
          view: {
            type: 'string',
            enum: ['inventory', 'source'],
            description: 'inventory (default) or numbered HTML source'
          }
        }
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'propose_gui_changes',
      description:
        'Propose a structured GUI HTML patch. ONE screen per call (replace-screen-html or add-screen) with a complete inner layout (navbar/sidebar/hero/cards/forms/tables), not a single button and not every screen at once. Ops: add-screen (optional html), remove-screen, add-widget, replace-html, replace-screen-html, insert-html, patch-node, remove-node. Whitelist HTML5 tags; any as-* class is allowed. Bind with data-process / data-bind / data-nav. Inline <script type="text/as-logic"> is allowed for calculations and animations and runs in a sandbox. Also allowed: onclick, oninput, onchange. Never emit <script src>, style=, href, or src.',
      parameters: {
        type: 'object',
        properties: {
          explanation: { type: 'string' },
          operations: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                op: {
                  type: 'string',
                  enum: [
                    'add-screen',
                    'remove-screen',
                    'add-widget',
                    'replace-html',
                    'replace-screen-html',
                    'insert-html',
                    'patch-node',
                    'remove-node'
                  ]
                },
                id: { type: 'string' },
                name: { type: 'string' },
                screenId: { type: 'string' },
                kind: { type: 'string' },
                label: { type: 'string' },
                process: { type: 'string' },
                nav: { type: 'string' },
                html: { type: 'string' },
                text: { type: 'string' }
              },
              required: ['op']
            }
          }
        },
        required: ['operations']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'propose_refinement_step',
      description:
        'Submit an auditable Hybrid refinement step. Informal atoms may only become formal via FormalizePredicate. Operational grain closes only via ClassifyGrain, ResolveVariation, or DecomposeProcess — rewriting pre/post does not reduce grainAmbiguity. DecomposeProcess creates a child module and an empty CDFD. SetCdfd writes or replaces one module cdfd block (toText). Missing cdfd on an existing module is not an error — do not invent a CDFD unless the user asks to draw or refine the data-flow diagram.',
      parameters: {
        type: 'object',
        properties: {
          explanation: { type: 'string' },
          traceLinks: {
            type:'array',description:'For any new semantic nodes introduced by this refinement, include their exact Informal sourceId and complete resulting Hybrid targetId. Retain existing source bindings.',
            items:{type:'object',properties:{sourceId:{type:'string'},targetId:{type:'string'},relation:{type:'string',enum:['refines','constrains','uses']}},required:['sourceId','targetId']}
          },
          kind: {
            type: 'string',
            enum: [
              'FormalizePredicate',
              'DecomposeProcess',
              'BalanceFlows',
              'DefineType',
              'BindConstraint',
              'DeclareAtomic',
              'Extend',
              'IntroduceRetrieve',
              'DischargeDataObligation',
              'SetCdfd',
              'ClassifyGrain',
              'ResolveVariation'
            ]
          },
          grainClass: { type: 'string', enum: ['operation', 'abstract'], description: 'ClassifyGrain: operation is one trigger; abstract is still a concern' },
          variationId: { type: 'string', description: 'ResolveVariation: id from the grain digest, or name-claim' },
          disposition: { type: 'string', enum: ['scenario', 'child', 'waived'], description: 'ResolveVariation. child requires toText = child process name. waived requires note.' },
          moduleName: { type: 'string' },
          processName: { type: 'string' },
          typeName: { type: 'string' },
          clause: { type: 'string', enum: ['pre', 'post', 'fsf'] },
          fromText: { type: 'string' },
          toText: { type: 'string' },
          childModuleName: { type: 'string' },
          representationType: { type: 'string' },
          retrieveFunction: { type: 'string' },
          retrieveBody: { type: 'string' },
          note: { type: 'string' }
        },
        required: ['kind']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'propose_source_edit',
      description:
        'Last-resort source-level edit of Informal markdown, Hybrid .asfl, or GUI html. Prefer propose_changes / propose_hybrid_changes / propose_gui_changes. Use this only when CRUD failed, leftover unparsed text remains, inventory is empty/out of sync, or you must fix text the structured tools cannot express. Read view=source first. Pass target "gui" for the GUI file and edit one screen, not the whole document. Ops: replace (unique oldText → newText; all:true to replace every match), append, replace-document.',
      parameters: {
        type: 'object',
        properties: {
          target: {
            type: 'string',
            enum: ['informal', 'hybrid', 'gui'],
            description: 'Which open specification file to edit'
          },
          explanation: { type: 'string' },
          traceLinks: {
            type: 'array',
            description: 'For target=hybrid, include exact Informal sourceId and fully qualified targetId for every new semantic node; existing bindings are retained.',
            items: {type:'object',properties:{sourceId:{type:'string'},targetId:{type:'string'},relation:{type:'string',enum:['refines','constrains','uses']}},required:['sourceId','targetId']}
          },
          operations: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                op: { type: 'string', enum: ['replace', 'append', 'replace-document'] },
                oldText: { type: 'string', description: 'replace: unique snippet from the current source' },
                newText: { type: 'string' },
                text: { type: 'string', description: 'append or replace-document body' },
                all: { type: 'boolean', description: 'replace: replace every match of oldText' }
              },
              required: ['op']
            }
          }
        },
        required: ['operations']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'review_hybrid',
      description: 'Record a structured review of the current Hybrid specification.',
      parameters: {
        type: 'object',
        properties: {
          issues: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                dimension: {
                  type: 'string',
                  enum: ['completeness', 'precision', 'consistency', 'traceability']
                },
                message: { type: 'string' },
                nodeId: { type: 'string' }
              },
              required: ['dimension', 'message']
            }
          }
        },
        required: ['issues']
      }
    }
  }
]
