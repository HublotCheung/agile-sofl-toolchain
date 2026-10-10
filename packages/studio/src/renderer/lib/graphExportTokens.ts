/** Graph export theme tokens — values mirror packages/studio/src/renderer/styles/main.css */

export const GRAPH_EXPORT_THEME_VARS = [
  '--surface-base',
  '--surface-raised',
  '--text-primary',
  '--text-secondary',
  '--text-muted',
  '--border-subtle',
  '--accent',
  '--role-process',
  '--role-function',
  '--map-frontend',
  '--map-backend',
  '--map-database',
  '--map-process',
  '--map-store',
  '--map-external',
  '--map-start',
  '--map-active',
  '--map-waiting',
  '--map-decision',
  '--map-success',
  '--map-failure'
] as const

export const LIGHT_GRAPH_EXPORT_TOKENS: Record<string, string> = {
  '--surface-base': '#f2f1ed',
  '--surface-raised': '#fcfbf8',
  '--text-primary': '#322d26',
  '--text-secondary': '#56524b',
  '--text-muted': '#6d6861',
  '--border-subtle': '#dad7d0',
  '--accent': '#00668b',
  '--role-process': '#146272',
  '--role-function': '#9b532a',
  '--map-frontend': '#0e6c66',
  '--map-backend': '#326541',
  '--map-database': '#535088',
  '--map-process': '#146272',
  '--map-store': '#694a77',
  '--map-external': '#66635a',
  '--map-start': '#326541',
  '--map-active': '#0e6c66',
  '--map-waiting': '#856214',
  '--map-decision': '#9b532a',
  '--map-success': '#326541',
  '--map-failure': '#9c433f'
}

export const DARK_GRAPH_EXPORT_TOKENS: Record<string, string> = {
  '--surface-base': '#1a1814',
  '--surface-raised': '#25221f',
  '--text-primary': '#e9e8e2',
  '--text-secondary': '#bfbeb7',
  '--text-muted': '#9b9890',
  '--border-subtle': '#403d37',
  '--accent': '#79b4d2',
  '--role-process': '#89bbc7',
  '--role-function': '#dba383',
  '--map-frontend': '#8bc4be',
  '--map-backend': '#93bd9d',
  '--map-database': '#acabdc',
  '--map-process': '#89bbc7',
  '--map-store': '#c0a6cc',
  '--map-external': '#a7a49c',
  '--map-start': '#93bd9d',
  '--map-active': '#8bc4be',
  '--map-waiting': '#d5ba82',
  '--map-decision': '#dba383',
  '--map-success': '#93bd9d',
  '--map-failure': '#de958e'
}

export function graphThemeVars(theme: 'current' | 'light' | 'dark'): Record<string, string> {
  if (theme === 'light') return { ...LIGHT_GRAPH_EXPORT_TOKENS }
  if (theme === 'dark') return { ...DARK_GRAPH_EXPORT_TOKENS }
  const root = document.documentElement
  const out: Record<string, string> = {}
  for (const v of GRAPH_EXPORT_THEME_VARS) {
    out[v] = getComputedStyle(root).getPropertyValue(v).trim()
  }
  return out
}

export function graphExportStyleBlock(vars: Record<string, string>): string {
  const rootVars = Object.entries(vars)
    .map(([k, v]) => `${k}: ${v.trim()};`)
    .join('\n')
  return `:root { ${rootVars} }
text { font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; }`
}
