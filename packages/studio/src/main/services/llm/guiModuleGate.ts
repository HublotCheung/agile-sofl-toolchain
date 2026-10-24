/** A Hybrid GUI module is `module GUI_…` or a `gui` block. gui.html alone does not count. */
export function missingHybridGuiModule(hybridAsfl: string | undefined): { missing: false } | { missing: true; parentId: string } {
  const source = hybridAsfl ?? ''
  if (/\bmodule\s+GUI_/i.test(source) || /(^|\n)\s*gui\s+[A-Za-z_]/i.test(source)) return { missing: false }
  const system = /module\s+SYSTEM_([A-Za-z_][A-Za-z0-9_]*)/i.exec(source)
  return { missing: true, parentId: system ? `mod:${system[1]}` : 'mod:<SystemName>' }
}

export function guiModuleRequiredError(parentId: string): string {
  return `No Hybrid GUI module yet. gui.html is only the prototype. First call propose_hybrid_changes: op=add kind=module name=GUI_App parentId=${parentId}. Do not ask again if the user already requested a GUI module or prototype. After that module is applied, continue with propose_gui_changes.`
}
