import { monaco } from '../monaco/setup'

const MAX_SEED = 256

export function captureFindQuery(): string | null {
  const active = document.activeElement
  if (active instanceof Element && active.closest('[data-search-widget]')) return null
  try {
    for (const editor of monaco.editor.getEditors()) {
      if (!editor.hasTextFocus()) continue
      const model = editor.getModel()
      const selection = editor.getSelection()
      if (!model || !selection || selection.isEmpty()) continue
      if (selection.startLineNumber !== selection.endLineNumber) continue
      const text = model.getValueInRange(selection)
      if (text.trim() && text.length <= MAX_SEED) return text
    }
  } catch {
    /* monaco is not ready */
  }
  const dom = window.getSelection()?.toString() ?? ''
  if (dom.trim() && !dom.includes('\n') && dom.length <= MAX_SEED) return dom
  return null
}
