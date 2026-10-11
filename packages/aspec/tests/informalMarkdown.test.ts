import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import {
  parseInformalSpec,
  serializeInformalSpec,
  applyInformalPatch,
  sampleInformalMarkdown,
  blankInformalMarkdown,
  detectAspecFormat,
  parseAspec,
  ruleBasedHybridGenerator,
  validateInformalSpec,
  formatInformalInventory
} from '../src/index.js'
import { check } from '@agile-sofl/parser'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

const SAMPLE_MD = `# Functions

## Register a customer

The system shall allow a customer to register a bank account.

### Input

- Customer name
- Account number
- Password

### Result

A new bank account is created.

## Withdraw from the bank account

The system shall allow a customer to withdraw money.

### Check the card ID and password

The system shall verify the card ID and password.

### Check the amount for withdrawal

The system shall verify that the withdrawal amount is valid.

### Update the account balance

The system shall subtract the withdrawal amount
from the account balance.

# Data Resources

## Bank Account

### Account Name

The name of the account owner.

### Account Number

The unique number of the bank account.

### Account Password

The password associated with the account.

### Account Balance

The current balance of the account.

## Accounts File

A persistent collection of bank accounts.

# Constraints

## Withdrawal Limit

Each withdrawal must not exceed 200,000 JPY.

## Non-negative Balance

The account balance cannot be less than 0.
`

describe('markdown informal spec', () => {
  it('detects markdown vs yaml', () => {
    expect(detectAspecFormat(SAMPLE_MD)).toBe('markdown')
    expect(detectAspecFormat('aspecVersion: "1.0"\nmeta:\n  id: x\n  title: t\nsystem:\n  name: S\n  purpose: p\nmodules: []\n')).toBe('yaml')
  })

  it('parses the PRD sample into Functions / Data Resources / Constraints', () => {
    const { specification, diagnostics } = parseInformalSpec(SAMPLE_MD)
    expect(diagnostics.filter((d) => d.severity === 'error')).toHaveLength(0)
    expect(specification).toBeTruthy()
    const fn = specification!.sections.find((s) => s.type === 'functions')
    const dr = specification!.sections.find((s) => s.type === 'data-resources')
    const c = specification!.sections.find((s) => s.type === 'constraints')
    expect(fn?.children.map((n) => n.title)).toEqual([
      'Register a customer',
      'Withdraw from the bank account'
    ])
    expect(dr?.children.map((n) => n.title)).toEqual(['Bank Account', 'Accounts File'])
    expect(c?.children.map((n) => n.title)).toEqual(['Withdrawal Limit', 'Non-negative Balance'])
    const withdraw = fn!.children[1]!
    const nested = withdraw.metadata?.nested as { title: string }[]
    expect(nested.map((n) => n.title)).toEqual([
      'Check the card ID and password',
      'Check the amount for withdrawal',
      'Update the account balance'
    ])
  })

  it('round-trips parse(serialize(model))', () => {
    const { specification } = parseInformalSpec(SAMPLE_MD)
    const text = serializeInformalSpec(specification!)
    expect(text.startsWith('# Functions')).toBe(true)
    expect(text).not.toContain('<!-- @id:')
    expect(text).not.toContain('\nmoduleId:')
    expect(text).not.toMatch(/^---$/m)
    const again = parseInformalSpec(text)
    expect(again.specification?.sections.map((s) => s.type)).toEqual(
      specification!.sections.map((s) => s.type)
    )
    expect(again.specification?.sections[0]?.children.map((c) => c.title)).toEqual(
      specification!.sections[0]?.children.map((c) => c.title)
    )
    expect(again.specification?.sections[0]?.children[0]?.id).toBe(
      specification!.sections[0]?.children[0]?.id
    )
  })

  it('rejects unknown top-level headings', () => {
    const { diagnostics } = parseInformalSpec('# Random Things\n\n## Login\n')
    expect(diagnostics.some((d) => d.code === 'ASPEC_MD_001')).toBe(true)
  })

  it('applies structured patches', () => {
    const { specification } = parseInformalSpec(blankInformalMarkdown())
    const { spec } = applyInformalPatch(specification!, {
      operations: [
        {
          op: 'add',
          target: 'functions',
          node: { type: 'function', title: 'User Login', description: 'Sign in with email.' }
        },
        {
          op: 'add',
          target: 'data-resources',
          node: { type: 'data-resource', title: 'User' }
        }
      ]
    })
    expect(spec.sections.find((s) => s.type === 'functions')?.children[0]?.title).toBe('User Login')
    expect(validateInformalSpec(spec).filter((d) => d.severity === 'error')).toHaveLength(0)
  })

  it('updates and removes existing nodes by id', () => {
    const { specification } = parseInformalSpec(`# Functions\n\n## Login\n\nSign in with a PIN.\n`)
    const login = specification!.sections.find((s) => s.type === 'functions')!.children[0]!
    const { spec } = applyInformalPatch(specification!, {
      operations: [
        { op: 'update', id: login.id, description: 'Sign in with card then PIN.' },
        { op: 'add', target: 'constraints', node: { type: 'constraint', title: 'PIN is 4 digits' } }
      ]
    })
    expect(spec.sections.find((s) => s.type === 'functions')?.children[0]?.description).toBe(
      'Sign in with card then PIN.'
    )
    const pin = spec.sections.find((s) => s.type === 'constraints')!.children[0]!
    const removed = applyInformalPatch(spec, { operations: [{ op: 'remove', id: pin.id }] })
    expect(removed.spec.sections.find((s) => s.type === 'constraints')?.children).toHaveLength(0)
  })

  it('formats an inventory with ids and descriptions for the agent', () => {
    const { specification } = parseInformalSpec(`# Functions\n\n## Login\n\nSign in with a PIN.\n`)
    const text = formatInformalInventory(specification)
    expect(text).toContain('(function) Login')
    expect(text).toContain('Sign in with a PIN.')
    expect(text).toMatch(/fn-login/)
  })

  it('normalizes section aliases used by the agent', () => {
    const { specification } = parseInformalSpec(blankInformalMarkdown())
    const { spec, diagnostics } = applyInformalPatch(specification!, {
      operations: [
        {
          op: 'add',
          target: 'Functions',
          node: { type: 'function', title: 'Check PIN' }
        },
        {
          op: 'add',
          target: '功能',
          node: { type: 'function', title: 'Withdraw' }
        }
      ]
    })
    expect(diagnostics.filter((d) => d.code === 'ASPEC_PATCH_001')).toHaveLength(0)
    expect(spec.sections.find((s) => s.type === 'functions')?.children.map((n) => n.title)).toEqual([
      'Check PIN',
      'Withdraw'
    ])
  })

  it('still reads legacy YAML frontmatter but does not keep it in displaySource', () => {
    const source = `---
moduleId: Library
title: Library System Informal Spec
---

# Functions

## Borrow
`
    const parsed = parseInformalSpec(source)
    expect(parsed.specification?.moduleId).toBe('Library')
    expect(parsed.specification?.metadata.title).toBe('Library System Informal Spec')
    expect(parsed.displaySource?.startsWith('# Functions')).toBe(true)
    expect(parsed.displaySource).not.toContain('moduleId:')
    expect(parsed.displaySource).not.toContain('<!-- @id:')
  })

  it('strips heading id comments from displaySource and still parses them', () => {
    const source = `# Functions\n\n## Login <!-- @id:fn-login -->\n\nSign in.\n`
    const parsed = parseInformalSpec(source)
    expect(parsed.specification?.sections[0]?.children[0]?.id).toBe('fn-login')
    expect(parsed.displaySource).toContain('## Login')
    expect(parsed.displaySource).not.toContain('@id:')
  })

  it('round-trips arbitrary nesting for functions, data sources, and constraints', () => {
    const source = `# Functions

## Level 1

### Level 2

#### Level 3

##### Level 4

###### Level 5

####### Level 6

######## Level 7

# Data Resources

## Account

### Owner

#### Name

##### Given

# Constraints

## Limit

### Daily

#### Per card
`
    const { specification, diagnostics } = parseInformalSpec(source)
    expect(diagnostics.filter((d) => d.severity === 'error')).toHaveLength(0)
    const titles: string[] = []
    const walk = (node: { title: string; type: string; metadata?: Record<string, unknown> }, expected: string) => {
      expect(node.type).toBe(expected)
      titles.push(node.title)
      const nested = (node.metadata?.nested as Array<{ title: string; type: string; metadata?: Record<string, unknown> }>) ?? []
      for (const child of nested) walk(child, expected === 'data-resource' ? 'data-field' : expected)
    }
    walk(specification!.sections[0]!.children[0]!, 'function')
    const functionTitles = [...titles]
    expect(functionTitles).toEqual(['Level 1', 'Level 2', 'Level 3', 'Level 4', 'Level 5', 'Level 6', 'Level 7'])
    walk(specification!.sections[1]!.children[0]!, 'data-resource')
    walk(specification!.sections[2]!.children[0]!, 'constraint')
    expect(titles).toContain('Given')
    expect(titles).toContain('Per card')

    const text = serializeInformalSpec(specification!)
    expect(text).toContain('######## Level 7')
    expect(text).toContain('#### Name')
    expect(text).toContain('### Daily')
    const again = parseInformalSpec(text)
    const againTitles: string[] = []
    const collect = (node: { title: string; metadata?: Record<string, unknown> }) => {
      againTitles.push(node.title)
      const nested = (node.metadata?.nested as Array<{ title: string; metadata?: Record<string, unknown> }>) ?? []
      for (const child of nested) collect(child)
    }
    collect(again.specification!.sections[0]!.children[0]!)
    expect(againTitles).toEqual(functionTitles)
  })

  it('duplicates a subtree and can insert before a sibling', () => {
    const { specification } = parseInformalSpec(`# Functions

## Login

### Check PIN

#### Format
`)
    const login = specification!.sections[0]!.children[0]!
    const duplicated = applyInformalPatch(specification!, {
      operations: [
        {
          op: 'add',
          target: 'functions',
          afterId: login.id,
          node: {
            type: 'function',
            title: 'Login copy',
            description: login.description,
            children: (login.metadata?.nested as Array<{ type: string; title: string; description?: string; metadata?: { nested?: unknown[] } }>) ?? []
          }
        }
      ]
    })
    const roots = duplicated.spec.sections[0]!.children
    expect(roots.map((node) => node.title)).toEqual(['Login', 'Login copy'])
    const copyNested = roots[1]!.metadata?.nested as Array<{ title: string; metadata?: { nested?: Array<{ title: string }> } }>
    expect(copyNested[0]?.title).toBe('Check PIN')
    expect(copyNested[0]?.metadata?.nested?.[0]?.title).toBe('Format')

    const moved = applyInformalPatch(duplicated.spec, {
      operations: [{ op: 'move', id: roots[1]!.id, parentId: 'functions', beforeId: login.id }]
    })
    expect(moved.spec.sections[0]!.children.map((node) => node.title)).toEqual(['Login copy', 'Login'])

    const cycle = applyInformalPatch(specification!, {
      operations: [{ op: 'move', id: login.id, parentId: ((login.metadata?.nested as Array<{ id: string }>) ?? [])[0]!.id }]
    })
    expect(cycle.diagnostics.some((d) => d.code === 'ASPEC_PATCH_001')).toBe(true)
    expect(cycle.spec.sections[0]!.children[0]?.title).toBe('Login')
  })

  it('parseAspec synthesizes a hybrid-ready document from markdown', () => {
    const { document, format } = parseAspec(SAMPLE_MD)
    expect(format).toBe('markdown')
    expect(document?.modules[0]?.processes?.some((p) => p.name.includes('Withdraw'))).toBe(true)
  })

  it('rule-based generator produces checkable ASFL', async () => {
    const { specification } = parseInformalSpec(sampleInformalMarkdown())
    const result = await ruleBasedHybridGenerator.generate(specification!, {})
    expect(result.asflText).toContain('module SYSTEM_')
    expect(result.asflText).toContain('process')
    expect(result.traceLinks.length).toBeGreaterThan(0)
    const checkResult = check(result.asflText)
    const errors = checkResult.diagnostics.filter((d) => d.severity === 'error')
    expect(errors).toHaveLength(0)
  })

  it('library example markdown refines to SYSTEM_Library / Borrow', () => {
    const source = readFileSync(join(repoRoot, 'examples', 'library-informal.aspec'), 'utf8')
    const { document, format } = parseAspec(source, {
      meta: { moduleId: 'Library', title: 'Library System Informal Spec' }
    })
    expect(format).toBe('markdown')
    expect(document?.modules[0]?.name).toBe('SYSTEM_Library')
    expect(document?.modules[0]?.processes?.some((p) => p.name === 'Borrow')).toBe(true)
  })
})
