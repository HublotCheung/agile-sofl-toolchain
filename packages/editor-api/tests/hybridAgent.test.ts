import { describe, it, expect } from 'vitest'
import {
  applyHybridPatch,
  collectHybridAgentDiagnostics,
  formatHybridDiagnostics,
  formatHybridInventory,
  hybridInventoryFromSource
} from '../src/index.js'

const SOURCE = `module SYSTEM_Demo;
process P1 (x: nat) ok: nat
    pre
        true
    post
        ok = 1
end_process
end_module`

const WITH_TYPE = `module SYSTEM_Demo;
type
    Account = nat;
process P1 (x: nat) ok: nat
    pre
        true
    post
        ok = 1
end_process
end_module`

describe('hybrid agent inventory and patch', () => {
  it('updates process ports through CRUD without changing its body', () => {
    const r = applyHybridPatch(SOURCE, { operations: [{ op: 'update', id: 'proc:Demo.P1', signature: '(x: nat, assigned: bool) ok: nat' }] })
    expect(r.error).toBeUndefined()
    expect(r.content).toBe(SOURCE.replace('(x: nat) ok: nat', '(x: nat, assigned: bool) ok: nat'))
  })
  it('rejects invalid process ports instead of silently accepting them', () => {
    const r = applyHybridPatch(SOURCE, { operations: [{ op: 'update', id: 'proc:Demo.P1', signature: '(x: nat, x: bool) ok: nat' }] })
    expect(r.error).toContain('Duplicate parameter')
    expect(r.content).toBe(SOURCE)
  })

  it('formatHybridInventory lists proc/type ids for a small module', () => {
    const text = formatHybridInventory(WITH_TYPE)
    expect(text).toContain('mod:Demo')
    expect(text).toContain('proc:Demo.P1')
    expect(text).toContain('type:Demo.Account')
    expect(text).toContain('(process) P1')
    expect(text).toContain('(type) Account')
    expect(hybridInventoryFromSource(WITH_TYPE)).toBe(text)
  })

  it('add process then inventory contains it', () => {
    const { content, error } = applyHybridPatch(SOURCE, {
      operations: [
        {
          op: 'add',
          kind: 'process',
          parentId: 'mod:SYSTEM_Demo',
          name: 'Withdraw',
          pre: 'x > 0',
          post: 'ok = x',
          signature: '(x: nat) ok: nat'
        }
      ]
    })
    expect(error).toBeUndefined()
    expect(content).toContain('process Withdraw')
    const inventory = formatHybridInventory(content)
    expect(inventory).toContain('proc:Demo.Withdraw')
    expect(inventory).toContain('proc:Demo.P1')
  })

  it('replace-process-body updates pre/post', () => {
    const { content, error } = applyHybridPatch(SOURCE, {
      operations: [
        {
          op: 'replace-process-body',
          id: 'proc:Demo.P1',
          pre: 'x > 1',
          post: 'ok = 2'
        }
      ]
    })
    expect(error).toBeUndefined()
    expect(content).toContain('x > 1')
    expect(content).toContain('ok = 2')
    expect(content).not.toContain('ok = 1')
    const inventory = formatHybridInventory(content)
    expect(inventory).toContain('pre: x > 1')
    expect(inventory).toContain('post: ok = 2')
  })

  it('add type/var', () => {
    const { content, error } = applyHybridPatch(SOURCE, {
      operations: [
        { op: 'add', kind: 'type', parentId: 'mod:Demo', name: 'Account' },
        { op: 'add', kind: 'var', parentId: 'mod:Demo', name: 'accounts', text: 'accounts: Account' }
      ]
    })
    expect(error).toBeUndefined()
    expect(content).toContain('Account = nat')
    expect(content).toContain('accounts: Account')
    const inventory = formatHybridInventory(content)
    expect(inventory).toContain('type:Demo.Account')
    expect(inventory).toContain('var:Demo.accounts')
  })

  it('add composed type via text', () => {
    const { content, error } = applyHybridPatch(SOURCE, {
      operations: [
        {
          op: 'add',
          kind: 'type',
          parentId: 'mod:Demo',
          name: 'TradeRecord',
          text: 'composed of tradeId: string orderId: string end'
        }
      ]
    })
    expect(error).toBeUndefined()
    expect(content).toContain('TradeRecord')
    expect(content).toContain('tradeId')
    expect(formatHybridInventory(content)).toContain('type:Demo.TradeRecord')
  })

  it('remove process', () => {
    const { content, error } = applyHybridPatch(SOURCE, {
      operations: [{ op: 'remove', id: 'proc:Demo.P1' }]
    })
    expect(error).toBeUndefined()
    expect(content).not.toContain('process P1')
    expect(formatHybridInventory(content)).not.toContain('proc:Demo.P1')
  })

  it('rejects replace-document instead of wiping the file', () => {
    const replacement = `module SYSTEM_Other;
end_module`
    const { content, error } = applyHybridPatch(SOURCE, {
      operations: [{ op: 'replace-document', asflText: replacement }]
    })
    expect(content).toBe(SOURCE)
    expect(error).toMatch(/replace-document|CRUD/)
    expect(formatHybridInventory(content)).toContain('mod:Demo')
    expect(content).toContain('process P1')
  })

  it('skips a type dump that would drop existing modules', () => {
    const { content, error } = applyHybridPatch(SOURCE, {
      operations: [
        {
          op: 'add',
          kind: 'type',
          parentId: 'mod:Demo',
          name: 'Broken',
          text: 'nat;\nend_module\n-- gone'
        }
      ]
    })
    expect(content).toContain('module SYSTEM_Demo')
    expect(content).toContain('process P1')
    expect(error).toMatch(/end_module|drop|CRUD|module/)
    expect(formatHybridInventory(content)).toContain('mod:Demo')
  })

  it('lists slim gui screens without widget dumps', () => {
    const content = `module SYSTEM_Demo;
gui DemoGui;
  screen Login triggers Demo.Login;
  screen Home;
end_gui;
process Login (user_id: nat) ok: bool
    pre
        true
    post
        ok = true
end_process
end_module`
    const inventory = formatHybridInventory(content)
    expect(inventory).toContain('(gui-screen) Login → Demo.Login')
    expect(inventory).not.toContain('widgets:')
  })

  it('keeps modules when pre contains punctuation that is not a token', () => {
    const { content, error } = applyHybridPatch(SOURCE, {
      operations: [
        {
          op: 'replace-process-body',
          id: 'proc:Demo.P1',
          pre: 'user is logged in?',
          post: 'ok = 1'
        }
      ]
    })
    expect(error).toBeUndefined()
    expect(content).toContain('module SYSTEM_Demo')
    expect(content).toContain('process P1')
    expect(formatHybridInventory(content)).toContain('mod:Demo')
    expect(formatHybridInventory(content)).toContain('proc:Demo.P1')
  })

  it('add module', () => {
    const { content, error } = applyHybridPatch(SOURCE, {
      operations: [{ op: 'add', kind: 'module', name: 'Extra' }]
    })
    expect(error).toBeUndefined()
    expect(content).toContain('module Extra')
    const inventory = formatHybridInventory(content)
    expect(inventory).toContain('mod:Demo')
    expect(inventory).toContain('mod:Extra')
  })

  it('empty source inventory', () => {
    expect(formatHybridInventory('')).toBe('(empty hybrid specification)')
  })

  it('surfaces per-module syntax errors in inventory and diagnostics report', () => {
    const broken = `module Auth;
type
  Role = {Investor} | {Broker}
process Login (id: nat)
    pre
        true
    post
        ok = 1
end_module
`
    const items = collectHybridAgentDiagnostics(broken)
    expect(items.length).toBeGreaterThan(0)
    expect(items.some((d) => d.severity === 'warning' || d.severity === 'error')).toBe(true)
    expect(items.some((d) => d.module === 'Auth' || d.line >= 1)).toBe(true)
    const report = formatHybridDiagnostics(broken)
    expect(report).toContain('## Diagnostics')
    expect(report).toMatch(/L\d+:C\d+/)
    expect(report).toMatch(/warning|error/i)
    const inventory = formatHybridInventory(broken)
    expect(inventory).toContain('## Diagnostics')
    expect(inventory).toContain('mod:Auth')
  })

  it('does not add a Diagnostics section when the hybrid spec parses cleanly', () => {
    expect(formatHybridInventory(WITH_TYPE)).not.toContain('## Diagnostics')
    expect(formatHybridDiagnostics(WITH_TYPE)).toBe('(no hybrid diagnostics)')
  })

  it('lists and updates invariants by zero-based inv:Module.index id', () => {
    const source = `module SYSTEM_M;
var x: nat;
inv
  x > 0;
  x < 10;
end_module`
    const inventory = formatHybridInventory(source)
    expect(inventory).toContain('inv:M.0')
    expect(inventory).toContain('inv:M.1')
    const { content, error } = applyHybridPatch(source, {
      operations: [{ op: 'update', id: 'inv:M.0', text: 'x >= 1' }]
    })
    expect(error).toBeUndefined()
    expect(content).toContain('x >= 1')
  })

  it('adds modules to an empty document without inventing SYSTEM_', () => {
    const { content, error } = applyHybridPatch('', {
      operations: [
        { op: 'add', kind: 'module', name: 'UserAuth' },
        { op: 'add', kind: 'module', name: 'MarketData' },
        { op: 'add', kind: 'module', name: 'GUI' }
      ]
    })
    expect(error).toBeUndefined()
    expect(content).toContain('module UserAuth')
    expect(content).toContain('module MarketData')
    expect(content).toContain('module GUI')
    const inventory = formatHybridInventory(content)
    expect(inventory).toContain('mod:UserAuth')
    expect(inventory).toContain('mod:MarketData')
    expect(inventory).toContain('mod:GUI')
    expect(inventory).not.toMatch(/mod:SYSTEM_$|mod:SYSTEM_\b/)
  })

  it('adds a type under missing mod:GUI by creating the module first', () => {
    const dotted = `${SOURCE.trimEnd()}.`
    const { content, error } = applyHybridPatch(dotted, {
      operations: [
        {
          op: 'add',
          kind: 'type',
          parentId: 'mod:GUI',
          name: 'Window',
          text: 'nat'
        }
      ]
    })
    expect(error).toBeUndefined()
    expect(content).toContain('module GUI')
    expect(content).toContain('Window = nat')
    const names = formatHybridInventory(content)
    expect(names).toContain('mod:GUI')
    expect(names).toContain('type:GUI.Window')
  })

  it('adds types without duplicating the type section', () => {
    const { content, error } = applyHybridPatch(SOURCE, {
      operations: [
        { op: 'add', kind: 'type', parentId: 'mod:Demo', name: 'A', text: 'nat' },
        { op: 'add', kind: 'type', parentId: 'mod:Demo', name: 'B', text: 'nat' }
      ]
    })
    expect(error).toBeUndefined()
    expect(content.match(/\btype\b/g)?.length).toBe(1)
    expect(content).toContain('A = nat')
    expect(content).toContain('B = nat')
  })

  it('resolves bare proc:Name and Chinese titles without Module.Entity', async () => {
    const { parseHybridId } = await import('../src/hybridIds.js')
    const bare = parseHybridId('proc:用户与权限')
    expect(bare?.bare).toBe(true)
    expect(bare?.entityName).toBe('用户与权限')
    const { content, error } = applyHybridPatch(SOURCE, {
      operations: [
        {
          op: 'add',
          kind: 'process',
          parentId: 'proc:用户与权限',
          name: 'Login',
          pre: 'true',
          post: 'ok = 1'
        }
      ]
    })
    expect(error).toBeUndefined()
    expect(content).toContain('module 用户与权限')
    expect(content).toContain('process Login')
  })

  it('updates a process via bare id proc:P1', () => {
    const { content, error } = applyHybridPatch(SOURCE, {
      operations: [{ op: 'replace-process-body', id: 'proc:P1', pre: 'x > 0', post: 'ok = x' }]
    })
    expect(error).toBeUndefined()
    expect(content).toContain('x > 0')
    expect(content).toContain('ok = x')
  })

  it('keeps successful ops when one id is unknown after adaptation', () => {
    const { content, error, warnings } = applyHybridPatch(SOURCE, {
      operations: [
        { op: 'add', kind: 'type', parentId: 'mod:Demo', name: 'Account', text: 'nat' },
        { op: 'remove', id: 'type:Demo.DoesNotExist' }
      ]
    })
    expect(content).toContain('Account = nat')
    expect(error).toBeUndefined()
    expect((warnings ?? []).join(' ')).toMatch(/Unknown hybrid id|DoesNotExist/)
  })
})
