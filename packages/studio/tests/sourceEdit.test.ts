import { describe, expect, it } from 'vitest'
import { applySourceEdits, isSourcePatch, numberedSource } from '../src/shared/sourceEdit'

describe('applySourceEdits', () => {
  it('replaces a unique snippet', () => {
    const r = applySourceEdits('module Foo;\nend_module', [
      { op: 'replace', oldText: 'Foo', newText: 'Bar' }
    ])
    expect(r.error).toBeUndefined()
    expect(r.applied).toBe(true)
    expect(r.content).toBe('module Bar;\nend_module')
  })

  it('errors when oldText is missing', () => {
    const r = applySourceEdits('module Foo;\nend_module', [
      { op: 'replace', oldText: 'Nope', newText: 'Bar' }
    ])
    expect(r.applied).toBe(false)
    expect(r.error).toMatch(/not found/)
    expect(r.content).toBe('module Foo;\nend_module')
  })

  it('accepts a unique match that differs only in whitespace or line endings', () => {
    const r = applySourceEdits('module Foo;\r\nend_module\r\nmodule Bar;\r\nend_module', [
      { op: 'replace', oldText: 'module Foo; end_module', newText: 'module Foo;\nconst x = 1;\nend_module' }
    ])
    expect(r.error).toBeUndefined()
    expect(r.content.startsWith('module Foo;\nconst x = 1;\nend_module\r\nmodule Bar;')).toBe(true)
    const twice = applySourceEdits('end_module\nend_module', [{ op: 'replace', oldText: 'end_module ', newText: 'x' }])
    expect(twice.applied).toBe(false)
  })

  it('errors on ambiguous replace unless all:true', () => {
    const src = 'aa aa'
    const once = applySourceEdits(src, [{ op: 'replace', oldText: 'aa', newText: 'bb' }])
    expect(once.applied).toBe(false)
    expect(once.error).toMatch(/2 times/)
    const all = applySourceEdits(src, [{ op: 'replace', oldText: 'aa', newText: 'bb', all: true }])
    expect(all.content).toBe('bb bb')
    expect(all.applied).toBe(true)
  })

  it('appends to an empty file', () => {
    const r = applySourceEdits('', [{ op: 'append', text: 'module UserAuth;\nend_module' }])
    expect(r.content).toBe('module UserAuth;\nend_module')
    expect(r.applied).toBe(true)
  })

  it('replace-document overwrites the file', () => {
    const r = applySourceEdits('garbage', [
      { op: 'replace-document', text: 'module GUI;\nend_module' }
    ])
    expect(r.content).toBe('module GUI;\nend_module')
    expect(r.error).toBeUndefined()
  })
})

describe('isSourcePatch / numberedSource', () => {
  it('treats mode=source as a source patch', () => {
    expect(isSourcePatch({ mode: 'source', operations: [{ op: 'add' }] })).toBe(true)
  })

  it('treats replace/append/replace-document ops as source', () => {
    expect(isSourcePatch({ operations: [{ op: 'replace', oldText: 'a', newText: 'b' }] })).toBe(true)
    expect(isSourcePatch({ operations: [{ op: 'add', kind: 'module', name: 'A' }] })).toBe(false)
  })

  it('numbers source lines and reports empty files', () => {
    expect(numberedSource('')).toBe('(empty file)')
    expect(numberedSource('a\nb')).toMatch(/1\| a/)
  })
})
