import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useWorkspaceStore } from '../src/renderer/stores/workspace'
import { useDocumentStore } from '../src/renderer/stores/document'
import type { WorkspaceScanPayload } from '../src/shared/projectTypes'

function scanWith(
  files: WorkspaceScanPayload['files'],
  modules: Array<{ name: string; filePath: string }>
): WorkspaceScanPayload {
  return {
    root: '/proj',
    manifest: { version: '1.0', name: 'Proj', informal: 'spec.aspec', hybrid: ['system.asfl'] },
    files,
    modules: modules.map((m) => ({
      name: m.name,
      displayName: m.name,
      filePath: m.filePath,
      isSystem: true,
      isGui: false,
      spanStart: 0,
      spanEnd: 0
    }))
  }
}

describe('workspace panel focus and dirty', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('records the focused panel', () => {
    const workspace = useWorkspaceStore()
    expect(workspace.focusedPanel).toBeNull()
    workspace.setFocusedPanel('informal')
    expect(workspace.focusedPanel).toBe('informal')
    workspace.setFocusedPanel('hybrid')
    expect(workspace.focusedPanel).toBe('hybrid')
  })

  it('collapses the structure column independently of the center dock', () => {
    const workspace = useWorkspaceStore()
    expect(workspace.structureCollapsed).toBe(false)
    expect(workspace.informalCollapsed).toBe(false)
    workspace.setStructureCollapsed(true)
    expect(workspace.structureCollapsed).toBe(true)
    expect(workspace.informalCollapsed).toBe(false)
  })

  it('collapses the project tree column independently of the structure column', () => {
    const workspace = useWorkspaceStore()
    workspace.setStructureCollapsed(true)
    workspace.setInformalCollapsed(true)
    expect(workspace.informalCollapsed).toBe(true)
    expect(workspace.structureCollapsed).toBe(true)
    workspace.setInformalCollapsed(false)
    expect(workspace.informalCollapsed).toBe(false)
    expect(workspace.structureCollapsed).toBe(true)
  })

  it('switches structure maps without treating graph as a mode', () => {
    const workspace = useWorkspaceStore()
    expect(workspace.structureMode).toBe('tree')
    workspace.structureMode = 'architecture'
    expect(workspace.structureMode).toBe('architecture')
    workspace.structureMode = 'dataflow'
    expect(workspace.structureMode).toBe('dataflow')
  })

  it('isHybridDirty follows the hybrid document tab', () => {
    const doc = useDocumentStore()
    const workspace = useWorkspaceStore()
    const tab = doc.openFromFile('/proj/system.asfl', 'module A; end_module', 'system.asfl')
    workspace.scan = scanWith(
      [{ path: '/proj/system.asfl', kind: 'asfl' }],
      [{ name: 'A', filePath: '/proj/system.asfl' }]
    )
    workspace.selectedModuleName = 'A'
    expect(workspace.isHybridDirty()).toBe(false)
    doc.setContent(tab.id, 'module A; var x: nat; end_module')
    expect(workspace.isHybridDirty()).toBe(true)
  })

  it('tabForFocusedPanel maps informal and hybrid panels', () => {
    const doc = useDocumentStore()
    const workspace = useWorkspaceStore()
    const aspec = doc.openFromFile('/proj/spec.aspec', '# Functions\n', 'spec.aspec')
    const asfl = doc.openFromFile('/proj/system.asfl', 'module A; end_module', 'system.asfl')
    workspace.scan = scanWith(
      [
        { path: '/proj/spec.aspec', kind: 'aspec' },
        { path: '/proj/system.asfl', kind: 'asfl' }
      ],
      [{ name: 'A', filePath: '/proj/system.asfl' }]
    )
    workspace.selectedModuleName = 'A'
    workspace.setFocusedPanel('informal')
    expect(workspace.tabForFocusedPanel()?.id).toBe(aspec.id)
    workspace.setFocusedPanel('hybrid')
    expect(workspace.tabForFocusedPanel()?.id).toBe(asfl.id)
  })
})
