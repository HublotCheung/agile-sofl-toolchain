import { describe, expect, it } from 'vitest'
import { bindGeneratedTrace } from '../src/shared/traceInteraction'
import { emptyTrace } from '../src/shared/traceability'
import { generatedIRTraceLinks, refreshTrace } from '../src/main/services/traceEngine'
import { parseInformalSpec, ruleBasedHybridGenerator } from '@agile-sofl/aspec'
const informal='# Functions\n## Borrow\nBorrow books.\n# Data Resources\n# Constraints\n'
const pair={root:'D:/interaction',informalPath:'D:/interaction/r.aspec',hybridPath:'D:/interaction/s.asfl',informal,hybrid:'module SYSTEM_Library;\nend_module;'}
describe('modeling provenance',()=>{
  it('uses compiler provenance for rule-generated variables, types, processes and constraints',async()=>{
    const source=informal.replace('# Data Resources\n# Constraints\n','# Data Resources\n## Books\nA list of books.\n# Constraints\n## Limit\nNo more than five books.\n')
    const parsed=parseInformalSpec(source)
    const result=await ruleBasedHybridGenerator.generate(parsed.specification!,{})
    const links=generatedIRTraceLinks(result.specification,result.asflText)
    expect(links.some(l=>l.targetId.startsWith('var:'))).toBe(true)
    const before=refreshTrace(emptyTrace(),{...pair,informal:source})
    const after=refreshTrace(structuredClone(before),{...pair,informal:source,hybrid:result.asflText})
    bindGeneratedTrace(before,after,links,pair.informalPath,pair.hybridPath,()=>crypto.randomUUID())
  })
  it('binds derived scenarios and declarations from explicit process provenance',()=>{
    const before=refreshTrace(emptyTrace(),pair)
    const after=refreshTrace(structuredClone(before),{...pair,hybrid:'module SYSTEM_Library;\nconst limit = 5;\nprocess Borrow() success: nat\nFSF : limit > 0 && success = 1 || others && success = 0\nend_process;\nend_module;'})
    const source=after.entities.find(e=>e.side==='informal')!,target=after.entities.find(e=>e.kind==='process')!
    let id=0;bindGeneratedTrace(before,after,[{sourceId:source.locator,targetId:target.locator}],pair.informalPath,pair.hybridPath,()=>String(++id))
    for(const entity of after.entities.filter(e=>e.side==='hybrid'))expect(after.links.some(l=>l.target===entity.id)).toBe(true)
  })
  it('rejects a guessed or ambiguous target name',()=>{
    const before=refreshTrace(emptyTrace(),pair)
    const after=refreshTrace(structuredClone(before),{...pair,hybrid:'module SYSTEM_Library;\nprocess Borrow()\npost true\nend_process;\nend_module;'})
    const source=after.entities.find(e=>e.side==='informal')!
    expect(()=>bindGeneratedTrace(before,after,[{sourceId:source.locator,targetId:'Borrow'}],pair.informalPath,pair.hybridPath,()=>crypto.randomUUID())).toThrow('unresolved')
  })
})
