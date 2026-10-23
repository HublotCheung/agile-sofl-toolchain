import { describe, expect, it } from 'vitest'
import { groupPatchOperations, patchSectionId, sectionStartsOpen } from '../src/renderer/components/workspace/agent/patchSections'

describe('patch preview sections', () => {
  it('groups functions, data resources, and constraints and keeps document order inside a group', () => {
    const sections = groupPatchOperations([
      { op: 'add', kind: 'function', name: 'Register account' },
      { op: 'add', target: 'constraints', node: { type: 'constraint', title: 'Unique email' } },
      { op: 'add', kind: 'data-resource', name: 'Account' },
      { op: 'add', kind: 'function', name: 'Log in' },
      { op: 'add', node: { type: 'data-field', title: 'email' } }
    ])
    expect(sections.map((section) => section.id)).toEqual(['functions', 'data', 'constraints'])
    expect(sections[0].items.map((item) => item.op.name)).toEqual(['Register account', 'Log in'])
    expect(sections[1].items).toHaveLength(2)
    expect(sections[2].items).toHaveLength(1)
    expect(patchSectionId({ op: 'add', target: 'functions' })).toBe('functions')
  })

  it('keeps source edits and other kinds in their own sections', () => {
    const sections = groupPatchOperations([
      { op: 'replace', oldText: 'a', newText: 'b' },
      { op: 'add', kind: 'module', name: 'Class' },
      { op: 'append', text: 'tail' }
    ])
    expect(sections.map((section) => [section.id, section.items.length])).toEqual([
      ['source', 2],
      ['module', 1]
    ])
  })

  it('starts only short sections open', () => {
    expect(sectionStartsOpen(1)).toBe(true)
    expect(sectionStartsOpen(3)).toBe(true)
    expect(sectionStartsOpen(4)).toBe(false)
  })
})
