/** Restricted HTML5 dialect for Agile-SOFL GUI specifications. */

export const GUI_HTML_VERSION = 'html-1'

export const ALLOWED_TAGS = new Set([
  'div',
  'span',
  'section',
  'header',
  'footer',
  'nav',
  'main',
  'article',
  'aside',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'p',
  'label',
  'button',
  'input',
  'select',
  'option',
  'textarea',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'th',
  'td',
  'ul',
  'ol',
  'li',
  'dl',
  'dt',
  'dd',
  'form',
  'fieldset',
  'legend',
  'strong',
  'em',
  'small',
  'b',
  'i',
  'u',
  'mark',
  'abbr',
  'time',
  'code',
  'pre',
  'kbd',
  'blockquote',
  'figure',
  'figcaption',
  'img',
  'a',
  'hr',
  'br',
  'progress',
  'meter',
  'details',
  'summary',
  'script'
])

export const VOID_TAGS = new Set(['input', 'hr', 'img', 'br'])

export const ALLOWED_ATTRS = new Set([
  'id',
  'class',
  'type',
  'name',
  'placeholder',
  'value',
  'disabled',
  'checked',
  'selected',
  'readonly',
  'required',
  'rows',
  'cols',
  'for',
  'colspan',
  'rowspan',
  'alt',
  'title',
  'role',
  'aria-label',
  'aria-hidden',
  'aria-current',
  'maxlength',
  'min',
  'max',
  'step',
  'autocomplete',
  'data-app',
  'data-screen',
  'data-process',
  'data-bind',
  'data-nav',
  'data-scenario',
  'data-id',
  'data-placeholder',
  'data-role',
  'data-icon',
  'data-state',
  'data-layout',
  'data-size'
])

export const ALLOWED_CLASSES = new Set([
  'as-app',
  'as-screen',
  'as-shell',
  'as-sidebar',
  'as-content',
  'as-hero',
  'as-toolbar',
  'as-tabs',
  'as-tab',
  'as-tab-active',
  'as-split',
  'as-panel',
  'as-navbar',
  'as-row',
  'as-col',
  'as-grid',
  'as-grid-3',
  'as-grid-4',
  'as-stack',
  'as-card',
  'as-card-media',
  'as-stat',
  'as-badge',
  'as-chip',
  'as-avatar',
  'as-thumb',
  'as-empty',
  'as-alert',
  'as-alert-warn',
  'as-price',
  'as-gap-sm',
  'as-gap-md',
  'as-gap-lg',
  'as-gap-xl',
  'as-btn',
  'as-btn-primary',
  'as-btn-ghost',
  'as-btn-danger',
  'as-btn-lg',
  'as-btn-sm',
  'as-btn-block',
  'as-input',
  'as-select',
  'as-table',
  'as-list',
  'as-menu',
  'as-field',
  'as-title',
  'as-subtitle',
  'as-muted',
  'as-hint',
  'as-grow',
  'as-center',
  'is-hidden',
  'is-active'
])

/** Inline handlers the prototype may run inside the sandbox iframe. */
export const LOGIC_EVENT_ATTRS = new Set([
  'onclick',
  'oninput',
  'onchange',
  'onmouseenter',
  'onmouseleave'
])

export const DATA_ATTRS = [
  'data-app',
  'data-screen',
  'data-process',
  'data-bind',
  'data-nav',
  'data-scenario',
  'data-id'
] as const

export function isAllowedClass(name: string): boolean {
  if (ALLOWED_CLASSES.has(name)) return true
  return /^as-[a-z0-9-]+$/i.test(name)
}

export function isAllowedTag(name: string): boolean {
  return ALLOWED_TAGS.has(name.toLowerCase())
}

export function emptyGuiHtml(appName = 'App', screenName = 'Home'): string {
  return `<div class="as-app" data-app="${escapeAttr(appName)}">
  <section class="as-screen" data-screen="${escapeAttr(screenName)}">
    <header class="as-navbar">
      <h1 class="as-title">${escapeText(screenName)}</h1>
    </header>
    <main class="as-stack as-gap-md">
      <p class="as-muted">Compose a full prototype here — layout, cards, forms, and navigation.</p>
    </main>
  </section>
</div>
`
}

export function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function looksLikeYamlGui(source: string): boolean {
  const head = source.trimStart().slice(0, 80)
  return (
    head.startsWith('guispecVersion') ||
    /^meta:\s*$/m.test(source.slice(0, 200)) && source.includes('gui:')
  )
}
