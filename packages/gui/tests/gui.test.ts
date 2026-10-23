import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { parseGuiSpec } from '../src/parse.js'
import { validateGuiSpec } from '../src/validate.js'
import { buildGuiModel } from '../src/buildGuiModel.js'
import {
  patchGui,
  patchFieldById,
  extractGuiFromAspec,
  embedGuiInAspec,
  mergeGuiSources,
  formatGui,
  extractScreenHtml,
  wrapPrototypeHtml
} from '../src/patch.js'
import { buildSlimGuiBlockFromHtml } from '../src/asflTrace.js'
import { evalSimpleCondition, matchScenarios } from '../src/scenarioEval.js'
import { formatGuiInventory } from '../src/inventory.js'
import { listHtmlTree } from '../src/html.js'
import { GUI_IFRAME_SANDBOX, buildPrototypeSrcdoc } from '../src/prototypeDoc.js'

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

describe('parseGuiSpec', () => {
  it('parses HTML fixture', () => {
    const source = readFileSync(join(fixtures, 'minimal.gui.html'), 'utf8')
    const { document, diagnostics } = parseGuiSpec(source)
    expect(diagnostics).toHaveLength(0)
    expect(document?.gui.app.name).toBe('MinimalApp')
    expect(document?.gui.screens[0]?.name).toBe('HomePage')
  })

  it('migrates YAML guispec', () => {
    const source = readFileSync(join(fixtures, 'minimal.guispec'), 'utf8')
    const { document, diagnostics } = parseGuiSpec(source)
    expect(diagnostics).toHaveLength(0)
    expect(document?.gui.screens[0]?.name).toBe('HomePage')
    expect(document?.html).toContain('data-screen="HomePage"')
  })

  it('keeps sandbox logic scripts and drops host-breaking markup', () => {
    const { document } = parseGuiSpec(
      `<div class="as-app" data-app="X"><section class="as-screen" data-screen="A"><button class="as-btn" onclick="n.textContent = String(+n.textContent + 1)">Go</button><button class="as-btn" onload="location.reload()">No</button><a href="javascript:location.reload()">x</a><script src="https://evil.example/x.js"></script><script type="text/as-logic">
var n = document.querySelector('[data-bind="out:price"]');
setInterval(function () { if (n && +n.textContent < 10) n.textContent = (+n.textContent + 0.01).toFixed(2); }, 800);
</script></section></div>`
    )
    expect(document?.html).toContain('type="text/as-logic"')
    expect(document?.html).toContain('setInterval')
    expect(document?.html).toContain('onclick=')
    expect(document?.html).not.toContain('onload')
    expect(document?.html).not.toContain('javascript:')
    expect(document?.html).not.toContain('evil.example')
    expect(document?.html).not.toContain('src=')
  })

  it('builds a prototype document that cannot navigate the parent', () => {
    const html = `<div class="as-app" data-app="X"><section class="as-screen" data-screen="A"><span data-bind="out:price">1.00</span><script type="text/as-logic">setInterval(function(){}, 800);</script></section></div>`
    const doc = buildPrototypeSrcdoc(html, 'body{color:red}', true)
    expect(GUI_IFRAME_SANDBOX).toBe('allow-scripts')
    expect(GUI_IFRAME_SANDBOX).not.toMatch(/allow-top-navigation|allow-same-origin|allow-forms|allow-popups/)
    expect(doc).toContain("default-src 'none'")
    expect(doc).toContain('setInterval')
    expect(doc).toContain('preventDefault')
    expect(doc).toContain('agile-sofl-gui')
    expect(doc).not.toContain('evil')
  })
})

describe('validateGuiSpec', () => {
  it('warns on unknown flow screen', () => {
    const source = readFileSync(join(fixtures, 'minimal.gui.html'), 'utf8')
    const { document } = parseGuiSpec(source)
    document!.gui.flows = [{ from: 'scr-home', to: 'scr-missing' }]
    const diags = validateGuiSpec(document!)
    expect(diags.some((d) => d.code === 'GUI_STYLE_003')).toBe(true)
  })
})

describe('patchGui', () => {
  it('updates screen title by id', () => {
    const source = readFileSync(join(fixtures, 'minimal.gui.html'), 'utf8')
    const next = patchFieldById(source, 'screen.scr-home.title', 'Welcome')
    expect(buildGuiModel(next).screens[0]?.title).toBe('Welcome')
  })

  it('adds and removes screen', () => {
    const source = readFileSync(join(fixtures, 'minimal.gui.html'), 'utf8')
    const withScreen = patchGui(source, {
      action: 'add-screen',
      screen: { id: 'scr-x', name: 'Extra', widgets: [] }
    })
    expect(buildGuiModel(withScreen).screens).toHaveLength(2)
    const removed = patchGui(withScreen, { action: 'remove-screen', screenId: 'scr-x' })
    expect(buildGuiModel(removed).screens).toHaveLength(1)
  })

  it('replace-screen-html keeps every child, not only the first', () => {
    const source = `<div class="as-app" data-app="Shop"><section class="as-screen" id="Home" data-screen="Home"><h1 class="as-title">Home</h1></section></div>`
    const next = patchGui(source, {
      action: 'replace-screen-html',
      screenId: 'Home',
      html: `<header class="as-navbar"><h1 class="as-title">Store</h1></header>
        <div class="as-hero"><p class="as-muted">Tonight only</p></div>
        <div class="as-grid as-gap-md">
          <article class="as-card"><h2 class="as-subtitle">Ramen</h2><button class="as-btn as-btn-primary" data-nav="Cart">Add</button></article>
          <article class="as-card as-promo"><p>Deal</p></article>
        </div>`
    })
    expect(next).toContain('as-navbar')
    expect(next).toContain('as-hero')
    expect(next).toContain('as-card')
    expect(next).toContain('as-promo')
    expect(next).toContain('data-nav="Cart"')
    expect(formatGuiInventory(next)).toContain('<header>')
    expect(formatGuiInventory(next)).toContain('as-hero')
  })

  it('add-screen accepts a full html layout', () => {
    const source = `<div class="as-app" data-app="Shop"><section class="as-screen" data-screen="Home"><h1 class="as-title">Home</h1></section></div>`
    const next = patchGui(source, {
      action: 'add-screen',
      screen: {
        id: 'Cart',
        name: 'Cart',
        html: `<section class="as-screen" data-screen="Cart">
          <header class="as-navbar"><h1 class="as-title">Cart</h1></header>
          <ul class="as-list"><li>Item</li></ul>
          <button class="as-btn as-btn-primary" data-process="Order.Checkout">Pay</button>
        </section>`
      }
    })
    expect(buildGuiModel(next).screens.map((s) => s.name)).toContain('Cart')
    expect(next).toContain('data-process="Order.Checkout"')
    expect(next).toContain('as-navbar')
  })

  it('extracts one screen as its own html file and wraps a prototype page', () => {
    const source = `<div class="as-app" data-app="Shop">
  <section class="as-screen" id="view-home" data-screen="Home"><h1 class="as-title">Home</h1>
    <button class="as-btn" data-nav="Cart">Go</button>
  </section>
  <section class="as-screen" id="view-cart" data-screen="Cart"><h1 class="as-title">Cart</h1></section>
</div>`
    const home = extractScreenHtml(source, 'Home')
    const cart = extractScreenHtml(source, 'view-cart')
    expect(home).toContain('data-screen="Home"')
    expect(home).toContain('data-nav="Cart"')
    expect(home).not.toContain('data-screen="Cart"')
    expect(cart).toContain('data-screen="Cart"')
    expect(cart).not.toContain('data-screen="Home"')
    const hidden = `<div class="as-app"><section class="as-screen is-hidden" data-screen="交易明细"><h1 class="as-title">交易明细</h1></section></div>`
    const shown = extractScreenHtml(hidden, '交易明细')
    expect(shown).toContain('交易明细')
    expect(shown).not.toContain('is-hidden')
    const page = wrapPrototypeHtml('Shop', home)
    expect(page).toContain('data-app="Shop"')
    expect(page).toContain('data-screen="Home"')
    expect(page).not.toContain('data-screen="Cart"')
    const swapped = patchGui(source, {
      action: 'replace-screen-html',
      screenId: 'Cart',
      html: '<header class="as-navbar"><h1 class="as-title">Bag</h1></header><button class="as-btn" data-nav="Home">Back</button>'
    })
    expect(extractScreenHtml(swapped, 'Cart')).toContain('data-nav="Home"')
    expect(extractScreenHtml(swapped, 'Home')).toContain('data-nav="Cart"')
  })

  it('adds widget to screen', () => {
    const source = readFileSync(join(fixtures, 'minimal.gui.html'), 'utf8')
    const next = patchGui(source, {
      action: 'add-widget',
      screenId: 'scr-home',
      widget: { id: 'w-btn', kind: 'button', label: 'Go', process: 'Auth.Login' }
    })
    expect(buildGuiModel(next).screens[0]?.widgetCount).toBeGreaterThanOrEqual(2)
    expect(next).toContain('data-process="Auth.Login"')
  })

  it('roundtrips navigate via data-nav', () => {
    const source = readFileSync(join(fixtures, 'minimal.gui.html'), 'utf8')
    const withEvents = patchFieldById(source, 'widget.w-nav.events', [
      { on: 'click', action: 'navigate', targetView: 'scr-home' }
    ])
    const model = buildGuiModel(withEvents)
    const widget = model.screens[0]?.widgets?.find((w) => w.id === 'w-nav')
    expect(widget?.nav ?? widget?.events?.[0]?.targetView).toBe('scr-home')
  })
})

describe('extract and merge', () => {
  it('extracts gui from aspec yaml', () => {
    const aspec = readFileSync(join(dirname(fixtures), '..', '..', 'aspec', 'tests', 'fixtures', 'minimal.aspec'), 'utf8')
    const withGui = embedGuiInAspec(aspec, {
      app: { name: 'LibUI' },
      screens: [{ id: 's1', name: 'Main', widgets: [] }]
    })
    const gui = extractGuiFromAspec(withGui)
    expect(gui?.app.name).toBe('LibUI')
  })

  it('merges external over embedded on id clash', () => {
    const embedded = {
      app: { name: 'A' },
      screens: [{ id: 's1', name: 'Embedded', widgets: [] }]
    }
    const external = {
      app: { name: 'B' },
      screens: [{ id: 's1', name: 'External', widgets: [] }]
    }
    const merged = mergeGuiSources(embedded, external)
    expect(merged?.screens[0]?.name).toBe('External')
    expect(merged?.app.name).toBe('B')
  })
})

describe('formatGui', () => {
  it('re-serializes document', () => {
    const source = readFileSync(join(fixtures, 'minimal.gui.html'), 'utf8')
    const formatted = formatGui(source.replace(/\n/g, '\n\n'))
    expect(buildGuiModel(formatted).app.name).toBe('MinimalApp')
  })
})

describe('buildGuiModel cross-ref', () => {
  it('warns when triggersProcess unknown', () => {
    const source = `<div class="as-app" data-app="A"><section class="as-screen" id="scr-home" data-screen="Home" data-process="proc-unknown"><h1 class="as-title">Home</h1></section></div>`
    const model = buildGuiModel(source, {
      informalModules: [{ id: 'm1', processes: [{ id: 'proc-borrow', name: 'Borrow' }] }]
    })
    expect(model.diagnostics.some((d) => d.code === 'GUI_STYLE_002')).toBe(true)
  })

  it('warns when data-bind param is not a process input', () => {
    const source = `<div class="as-app" data-app="A"><section class="as-screen" data-screen="Login">
      <input class="as-input" id="u" data-bind="param:missing" data-process="Auth.Login" />
    </section></div>`
    const model = buildGuiModel(source, {
      hybridProcesses: [
        { moduleName: 'Auth', processName: 'Login', inputs: ['user_id'], outputs: ['ok'], vars: [] }
      ]
    })
    expect(model.diagnostics.some((d) => d.code === 'GUI_HTML_003')).toBe(true)
  })
})

describe('coverageGui', () => {
  it('builds trace links for screens', async () => {
    const { buildGuiTraceLinks } = await import('../src/trace/coverageGui.js')
    const source = readFileSync(join(fixtures, 'minimal.gui.html'), 'utf8')
    const model = buildGuiModel(source)
    const links = buildGuiTraceLinks(model)
    expect(links.some((l) => l.kind === 'gui-screen')).toBe(true)
  })
})

describe('slim asfl trace', () => {
  it('emits screen triggers without widget lists', () => {
    const html = `<div class="as-app" data-app="Trading">
      <section class="as-screen" data-screen="Login" data-process="Auth.Login"><h1 class="as-title">Login</h1></section>
      <section class="as-screen" data-screen="Dashboard"><h1 class="as-title">Dash</h1></section>
    </div>`
    const block = buildSlimGuiBlockFromHtml(html)
    expect(block).toContain('screen Login triggers Auth.Login;')
    expect(block).toContain('screen Dashboard;')
    expect(block).not.toContain('button')
  })
})

describe('scenario eval', () => {
  it('evaluates simple comparisons', () => {
    expect(evalSimpleCondition('x > 0', { x: 2 })).toBe(true)
    expect(evalSimpleCondition('ok = true', { ok: true })).toBe(true)
    expect(evalSimpleCondition('name <> ""', { name: 'a' })).toBe(true)
  })

  it('matches a scenario and writes outputs', () => {
    const result = matchScenarios(
      [
        { id: 'ok', name: 'Success', kind: 'normal', guard: 'user_id > 0', definingCondition: 'ok = true' },
        { id: 'bad', name: 'Fail', kind: 'exceptional', guard: 'user_id = 0', definingCondition: 'ok = false' }
      ],
      { user_id: 3 }
    )
    expect(result.matched[0]?.id).toBe('ok')
    expect(result.outputs.ok).toBe(true)
  })
})

describe('inventory', () => {
  it('lists screens and processes', () => {
    const html = readFileSync(join(fixtures, 'minimal.gui.html'), 'utf8')
    expect(formatGuiInventory(html)).toContain('screen:HomePage')
  })
})

describe('html tree patch', () => {
  it('lists DOM paths and patches class/data-*', () => {
    const source = readFileSync(join(fixtures, 'minimal.gui.html'), 'utf8')
    const tree = listHtmlTree(source)
    expect(tree[0]?.tag).toBe('div')
    const screen = tree[0]?.children[0]
    expect(screen?.attrs['data-screen']).toBe('HomePage')
    const next = patchGui(source, {
      action: 'patch-node',
      path: screen!.path,
      attrs: { 'data-process': 'Auth.Login', class: 'as-screen as-stack' }
    })
    expect(next).toContain('data-process="Auth.Login"')
    const withBtn = patchGui(next, {
      action: 'insert-html',
      parentPath: screen!.path,
      html: '<button class="as-btn" data-nav="HomePage">Go</button>'
    })
    expect(withBtn).toContain('data-nav="HomePage"')
  })
})
