import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  applyReplacePattern,
  compileSearch,
  matchGlob,
  pathAllowed,
  preserveCaseReplace,
  replaceAllInText,
  replaceMatchesInText,
  searchInText,
  type TextSearchQuery
} from '../src/shared/textSearch'
import { searchProjectFiles } from '../src/main/services/textSearchFs'

const baseQuery = (patch: Partial<TextSearchQuery> = {}): TextSearchQuery => ({
  query: 'Note',
  matchCase: false,
  wholeWord: false,
  useRegex: false,
  include: '',
  exclude: '',
  ...patch
})

describe('text search', () => {
  it('matches any text, including prose outside code tokens', () => {
    const compiled = compileSearch(baseQuery({ query: 'hello' }))
    if (!('re' in compiled)) throw new Error(compiled.error)
    const { matches } = searchInText('module M;\n/* hello world */\nend_module\n', compiled.re, 20)
    expect(matches).toHaveLength(1)
    expect(matches[0]?.line).toBe(2)
    expect(matches[0]?.text).toBe('hello')
  })

  it('respects match case, whole word, and regex groups', () => {
    const source = 'Hello hello_world Hello'
    const cased = compileSearch(baseQuery({ query: 'Hello', matchCase: true }))
    if (!('re' in cased)) throw new Error('case')
    expect(searchInText(source, cased.re, 20).matches).toHaveLength(2)

    const word = compileSearch(baseQuery({ query: 'hello', wholeWord: true }))
    if (!('re' in word)) throw new Error('word')
    expect(searchInText('hello_world', word.re, 20).matches).toHaveLength(0)
    expect(searchInText('say hello.', word.re, 20).matches).toHaveLength(1)

    const grouped = compileSearch(baseQuery({ query: 'id-(\\d+)', useRegex: true, matchCase: true }))
    if (!('re' in grouped)) throw new Error(grouped.error)
    const found = searchInText('ticket id-42', grouped.re, 5)
    expect(found.matches[0]?.groups[1]).toBe('42')
    expect(applyReplacePattern(found.matches[0]!.groups, 'n$1', true)).toBe('n42')
  })

  it('preserves case and replaces only the matched spans', () => {
    expect(preserveCaseReplace('Hello', 'world')).toBe('World')
    expect(preserveCaseReplace('HELLO', 'world')).toBe('WORLD')
    const compiled = compileSearch(baseQuery({ query: 'cat', matchCase: true }))
    if (!('re' in compiled)) throw new Error('compile')
    const { matches } = searchInText('cat Cat', compiled.re, 10)
    const next = replaceMatchesInText('cat Cat', matches, 'dog', { useRegex: false, preserveCase: true })
    expect(next).toBe('dog Cat')
    expect(
      replaceAllInText('Keep the note', baseQuery({ query: 'note' }), 'remark', false)
    ).toBe('Keep the remark')
  })

  it('applies include and exclude globs', () => {
    expect(matchGlob('src/spec/system.aspec', '*.aspec')).toBe(true)
    expect(matchGlob('src/spec/system.asfl', '**/*.aspec')).toBe(false)
    expect(pathAllowed('notes/readme.txt', '*.txt', 'secret*')).toBe(true)
    expect(pathAllowed('notes/secret.txt', '', 'secret*')).toBe(false)
    expect(pathAllowed('src/mod.asfl', '**/*.asfl', '')).toBe(true)
  })

  it('searches project text files and marks non-editor files read-only', () => {
    const root = mkdtempSync(join(tmpdir(), 'studio-search-'))
    mkdirSync(join(root, 'notes'))
    writeFileSync(join(root, 'system.aspec'), '# Functions\n\nHello from informal\n', 'utf8')
    writeFileSync(join(root, 'system.asfl'), 'module SYSTEM_M;\nprocess Hello\nend_process\nend_module\n', 'utf8')
    writeFileSync(join(root, 'gui.html'), '<p>Hello screen</p>\n', 'utf8')
    writeFileSync(join(root, 'notes', 'readme.txt'), 'Hello notes\n', 'utf8')
    writeFileSync(join(root, 'picture.png'), Buffer.from([0, 1, 2, 3]))

    const result = searchProjectFiles({
      ...baseQuery({ query: 'Hello' }),
      root
    })
    const byName = new Map(
      result.files.map((file) => [file.path.replace(/\\/g, '/').split('/').pop()!, file])
    )
    expect(byName.get('system.aspec')?.replaceable).toBe(true)
    expect(byName.get('system.asfl')?.replaceable).toBe(true)
    expect(byName.get('gui.html')?.replaceable).toBe(true)
    expect(byName.get('readme.txt')?.replaceable).toBe(false)
    expect(byName.has('picture.png')).toBe(false)
    expect(result.files.every((file) => file.matches.some((match) => match.text.toLowerCase() === 'hello'))).toBe(
      true
    )
  })
})
