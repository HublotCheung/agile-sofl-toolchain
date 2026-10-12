import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useDocumentStore } from '../src/renderer/stores/document'
import { HOME_TAB_ID } from '../src/renderer/stores/tabUtils'

describe('document store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('starts with home tab only', () => {
    const doc = useDocumentStore()
    doc.initHome()
    expect(doc.tabs).toHaveLength(1)
    expect(doc.tabs[0].kind).toBe('home')
    expect(doc.activeTabId).toBe(HOME_TAB_ID)
    expect(doc.isHomeActive).toBe(true)
  })

  it('creates document tab on newTab', () => {
    const doc = useDocumentStore()
    doc.newTab()
    expect(doc.tabs).toHaveLength(2)
    expect(doc.documentTabs).toHaveLength(1)
    expect(doc.activeTab?.kind).toBe('document')
  })

  it('tracks dirty state on document tabs', () => {
    const doc = useDocumentStore()
    doc.newTab()
    const id = doc.activeTab!.id
    doc.updateContent(id, 'module SYSTEM_X;\nend_module\n')
    expect(doc.activeTab!.isDirty).toBe(true)
  })

  it('returns to home when last document tab is closed', () => {
    const doc = useDocumentStore()
    const tab = doc.newTab()
    doc.removeTab(tab.id)
    expect(doc.documentTabs).toHaveLength(0)
    expect(doc.isHomeActive).toBe(true)
  })

  it('opens multiple document tabs', () => {
    const doc = useDocumentStore()
    doc.openFromFile('/a.asfl', 'content a', 'a.asfl')
    doc.openFromFile('/b.asfl', 'content b', 'b.asfl')
    expect(doc.documentTabs).toHaveLength(2)
    expect(doc.tabs).toHaveLength(3)
  })

  it('reuses tab when opening the same file with a different path separator', () => {
    const doc = useDocumentStore()
    const first = doc.openFromFile('D:\\project\\spec.asfl', 'content', 'spec.asfl')
    const second = doc.openFromFile('D:/project/spec.asfl', 'other', 'spec.asfl')
    expect(doc.documentTabs).toHaveLength(1)
    expect(second.id).toBe(first.id)
    expect(doc.activeTabId).toBe(first.id)
    expect(doc.activeTab!.content).toBe('other')
  })

  it('does not overwrite a dirty tab when reopening the same file', () => {
    const doc = useDocumentStore()
    const first = doc.openFromFile('/proj/spec.asfl', 'saved', 'spec.asfl')
    doc.updateContent(first.id, 'unsaved')
    doc.openFromFile('/proj/spec.asfl', 'from-disk', 'spec.asfl')
    expect(doc.documentTabs).toHaveLength(1)
    expect(doc.activeTab!.content).toBe('unsaved')
  })

  it('closes tabs that are not under the given project root', () => {
    const doc = useDocumentStore()
    doc.openFromFile('/asfl/test/hybrid.asfl', 'module Auth; end_module', 'hybrid.asfl')
    doc.openFromFile('/asfl/food/hybrid.asfl', 'module Delivery; end_module', 'hybrid.asfl')
    doc.openFromFile('/asfl/food/informal.aspec', '# Functions\n', 'informal.aspec')
    doc.closeTabsOutsideRoot('/asfl/food')
    expect(doc.documentTabs.map((t) => t.filePath)).toEqual([
      '/asfl/food/hybrid.asfl',
      '/asfl/food/informal.aspec'
    ])
  })

  it('does not remove home tab', () => {
    const doc = useDocumentStore()
    doc.removeTab(HOME_TAB_ID)
    expect(doc.tabs.some((t) => t.id === HOME_TAB_ID)).toBe(true)
  })

  it('links aspec and asfl tabs for refinement workflow', () => {
    const doc = useDocumentStore()
    const aspec = doc.newTab({ documentKind: 'aspec', title: 'spec.aspec' })
    const asfl = doc.newTab({ documentKind: 'asfl', title: 'spec.asfl' })
    doc.linkTabs(aspec.id, asfl.id)
    expect(doc.tabs.find((t) => t.id === aspec.id)?.linkedDocumentId).toBe(asfl.id)
    expect(doc.tabs.find((t) => t.id === asfl.id)?.linkedDocumentId).toBe(aspec.id)
  })

  it('does not write the session snapshot on every content change', () => {
    vi.useFakeTimers()
    try {
      const doc = useDocumentStore()
      const tab = doc.openFromFile('/proj/spec.asfl', 'module A;\nend_module', 'spec.asfl')
      sessionStorage.clear()
      doc.setContent(tab.id, 'module A;\nend_module\nprocess P()\nend_process')
      expect(sessionStorage.getItem('studio-workspace-session')).toBeNull()
      expect(doc.contentEpochByTab[tab.id]).toBeGreaterThan(0)
      vi.advanceTimersByTime(1200)
      const raw = sessionStorage.getItem('studio-workspace-session')
      expect(raw).toContain('process P()')
    } finally {
      vi.useRealTimers()
    }
  })

  it('marks a tab dirty without copying its text', () => {
    const doc = useDocumentStore()
    const tab = doc.openFromFile('/proj/spec.asfl', 'module A;\nend_module', 'spec.asfl')
    const epoch = doc.contentEpochByTab[tab.id] ?? 0
    doc.markDirty(tab.id)
    expect(tab.isDirty).toBe(true)
    expect(tab.content).toBe('module A;\nend_module')
    expect(doc.contentEpochByTab[tab.id] ?? 0).toBe(epoch)
    doc.beginPendingEdit(tab.id)
    expect(doc.hasPendingEdit(tab.id)).toBe(true)
    doc.endPendingEdit(tab.id)
    expect(doc.hasPendingEdit()).toBe(false)
  })

  it('infers aspec document kind from file path', () => {
    const doc = useDocumentStore()
    const tab = doc.openFromFile('/project/spec.aspec', 'aspecVersion: "1.0"\n', 'spec.aspec')
    expect(tab.documentKind).toBe('aspec')
  })
})
