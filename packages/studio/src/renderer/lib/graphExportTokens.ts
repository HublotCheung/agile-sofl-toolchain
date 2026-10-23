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
  '--surface-base': '#f3f6f8',
  '--surface-raised': '#ffffff',
  '--text-primary': '#12181d',
  '--text-secondary': '#3d4c58',
  '--text-muted': '#52606c',
  '--border-subtle': '#8aa0ae',
  '--accent': '#0c628c',
  '--role-process': '#0c628c',
  '--role-function': '#8a5a10',
  '--map-frontend': '#0c628c',
  '--map-backend': '#147a38',
  '--map-database': '#2e3a8c',
  '--map-process': '#0c628c',
  '--map-store': '#5c3d78',
  '--map-external': '#3d4c58',
  '--map-start': '#147a38',
  '--map-active': '#0c628c',
  '--map-waiting': '#8a5a10',
  '--map-decision': '#8a5a10',
  '--map-success': '#147a38',
  '--map-failure': '#9e2f2b'
}

export const DARK_GRAPH_EXPORT_TOKENS: Record<string, string> = {
  '--surface-base': '#0e1418',
  '--surface-raised': '#172027',
  '--text-primary': '#e8eef2',
  '--text-secondary': '#a9b8c2',
  '--text-muted': '#8a9ba6',
  '--border-subtle': '#3e5360',
  '--accent': '#8fcfe6',
  '--role-process': '#8fcfe6',
  '--role-function': '#e4c36a',
  '--map-frontend': '#8fcfe6',
  '--map-backend': '#8ee0a8',
  '--map-database': '#c5c8f2',
  '--map-process': '#8fcfe6',
  '--map-store': '#d4b4e0',
  '--map-external': '#a9b8c2',
  '--map-start': '#8ee0a8',
  '--map-active': '#8fcfe6',
  '--map-waiting': '#e4c36a',
  '--map-decision': '#e4c36a',
  '--map-success': '#8ee0a8',
  '--map-failure': '#f0a8a4'
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
