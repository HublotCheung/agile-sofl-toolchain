import { describe, expect, it } from 'vitest'
import { guiModuleRequiredError, missingHybridGuiModule } from '../src/main/services/llm/guiModuleGate'

describe('missingHybridGuiModule', () => {
  it('flags a hybrid file that only has semantic modules', () => {
    const gate = missingHybridGuiModule(`module SYSTEM_Pay;
end_module
module UserManagement / Pay;
end_module
`)
    expect(gate).toEqual({ missing: true, parentId: 'mod:Pay' })
  })

  it('accepts a GUI_ module and a gui block', () => {
    expect(missingHybridGuiModule('module GUI_App / Pay;\nend_module\n').missing).toBe(false)
    expect(missingHybridGuiModule('module App;\ngui Home;\nend_gui\nend_module\n').missing).toBe(false)
  })

  it('names the parent in the tool error', () => {
    expect(guiModuleRequiredError('mod:Pay')).toContain('parentId=mod:Pay')
    expect(guiModuleRequiredError('mod:Pay')).toContain('propose_hybrid_changes')
  })
})
