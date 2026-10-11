/** CSS for the sandboxed GUI prototype. Tokens are injected at runtime. */

export function prototypeStylesheet(vars: Record<string, string> = {}): string {
  const v = (name: string, fallback: string) => vars[name] ?? fallback
  return `html, body, :host {
  display: block;
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  min-height: 100%;
  margin: 0;
}
html, body { height: 100%; overflow: auto; }
*, *::before, *::after { box-sizing: border-box; }
html, body, :host, .as-app {
  --as-bg: ${v('--gui-canvas', v('--surface-base', '#eef1f4'))};
  --as-raised: ${v('--gui-surface-card', v('--surface-raised', '#fff'))};
  --as-ink: ${v('--gui-ink', v('--text-primary', '#15202b'))};
  --as-body: ${v('--gui-body', v('--text-secondary', '#4a5560'))};
  --as-muted: ${v('--gui-muted', v('--text-muted', '#7a8490'))};
  --as-line: ${v('--gui-hairline', v('--border-subtle', '#d8dee6'))};
  --as-accent: ${v('--gui-primary', v('--accent', '#2563eb'))};
  --as-accent-fg: ${v('--accent-fg', '#f8fafc')};
  --as-danger: ${v('--danger', '#e11d48')};
  --as-warn: ${v('--warn', '#d97706')};
  --as-field: ${v('--field-bg', '#fff')};
  --as-soft: color-mix(in srgb, var(--as-accent) 10%, var(--as-raised));
  font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
  color: var(--as-ink);
  background: var(--as-bg);
  font-size: 13px;
  line-height: 1.45;
}
.as-app { display: flex; flex-direction: column; width: 100%; min-height: 100%; background: var(--as-bg); }
.as-screen { display: flex; flex-direction: column; gap: 0; width: 100%; min-height: 100%; background: var(--as-bg); }
.as-screen.is-hidden { display: none; }
.as-shell { display: grid; grid-template-columns: 220px minmax(0, 1fr); min-height: 100%; }
.as-sidebar {
  display: flex; flex-direction: column; gap: 8px;
  padding: 16px 12px; background: var(--as-raised);
  border-right: 1px solid var(--as-line); min-height: 100%;
}
.as-content { display: flex; flex-direction: column; min-width: 0; min-height: 100%; }
.as-hero {
  display: flex; flex-direction: column; gap: 10px;
  padding: 28px 24px; color: var(--as-accent-fg);
  background: linear-gradient(135deg, var(--as-accent), color-mix(in srgb, var(--as-accent) 55%, #0f172a));
  border-radius: 0 0 18px 18px;
}
.as-hero .as-title, .as-hero .as-muted { color: inherit; }
.as-hero .as-muted { opacity: 0.85; }
.as-toolbar, .as-navbar {
  display: flex; flex-direction: row; flex-wrap: wrap; align-items: center; gap: 12px;
  padding: 10px 16px; border-bottom: 1px solid var(--as-line);
  background: var(--as-raised); width: 100%;
}
.as-tabs { display: flex; gap: 4px; padding: 8px 16px 0; border-bottom: 1px solid var(--as-line); background: var(--as-raised); }
.as-tab {
  border: 0; background: transparent; color: var(--as-muted); font-weight: 600;
  padding: 8px 12px; border-bottom: 2px solid transparent; cursor: pointer;
}
.as-tab-active, .as-tab.is-active { color: var(--as-accent); border-bottom-color: var(--as-accent); }
.as-split { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 16px; }
.as-panel { display: flex; flex-direction: column; gap: 12px; padding: 16px 20px; }
.as-row { display: flex; flex-direction: row; flex-wrap: wrap; align-items: center; }
.as-col { display: flex; flex-direction: column; }
.as-stack { display: flex; flex-direction: column; }
.as-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
.as-grid-3 { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); }
.as-grid-4 { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); }
.as-gap-sm { gap: 8px; }
.as-gap-md { gap: 12px; }
.as-gap-lg { gap: 20px; }
.as-gap-xl { gap: 28px; }
.as-grow { flex: 1 1 auto; min-width: 0; }
.as-center { align-items: center; justify-content: center; text-align: center; }
.as-card {
  background: var(--as-raised);
  border: 1px solid var(--as-line);
  border-radius: 14px;
  padding: 16px;
  box-shadow: 0 8px 24px rgb(15 23 42 / 6%);
}
.as-card-media { overflow: hidden; padding: 0; }
.as-stat { display: flex; flex-direction: column; gap: 4px; }
.as-stat .as-title { font-size: 22px; }
.as-badge, .as-chip {
  display: inline-flex; align-items: center; gap: 4px;
  border-radius: 999px; padding: 2px 8px; font-size: 11px; font-weight: 700;
  background: var(--as-soft); color: var(--as-accent);
}
.as-chip { background: color-mix(in srgb, var(--as-line) 55%, var(--as-raised)); color: var(--as-body); }
.as-avatar, .as-thumb {
  display: inline-flex; align-items: center; justify-content: center;
  background: var(--as-soft); color: var(--as-accent); font-weight: 700;
  overflow: hidden;
}
.as-avatar { width: 36px; height: 36px; border-radius: 50%; }
.as-thumb { width: 72px; height: 72px; border-radius: 12px; }
img.as-avatar, img.as-thumb { object-fit: cover; background: var(--as-soft); }
.as-empty {
  display: flex; flex-direction: column; align-items: center; gap: 8px;
  padding: 36px 16px; color: var(--as-muted); text-align: center;
}
.as-alert {
  padding: 10px 12px; border-radius: 10px;
  background: color-mix(in srgb, var(--as-accent) 12%, var(--as-raised));
  border: 1px solid color-mix(in srgb, var(--as-accent) 25%, var(--as-line));
}
.as-alert-warn {
  background: color-mix(in srgb, var(--as-warn) 12%, var(--as-raised));
  border-color: color-mix(in srgb, var(--as-warn) 30%, var(--as-line));
}
.as-price { font-weight: 750; font-variant-numeric: tabular-nums; color: var(--as-danger); }
.as-title { font-size: 18px; font-weight: 650; margin: 0; }
.as-subtitle { font-size: 15px; font-weight: 600; margin: 0; }
.as-muted, .as-hint { color: var(--as-muted); margin: 0; }
.as-field { display: flex; flex-direction: column; gap: 6px; font-weight: 500; }
.as-input, .as-select, textarea.as-input {
  border: 1px solid var(--as-line);
  background: var(--as-field);
  color: var(--as-ink);
  border-radius: 8px;
  padding: 8px 10px;
  min-height: 32px;
  width: 100%;
}
.as-input:focus, .as-select:focus { outline: 2px solid color-mix(in srgb, var(--as-accent) 40%, transparent); border-color: var(--as-accent); }
.as-btn {
  display: inline-flex; align-items: center; justify-content: center;
  flex: 0 0 auto; white-space: nowrap;
  border-radius: 8px; border: 1px solid var(--as-line);
  background: var(--as-raised); color: var(--as-ink);
  padding: 8px 14px; min-height: 32px; cursor: pointer; font-weight: 600;
}
.as-btn-primary { background: var(--as-accent); color: var(--as-accent-fg); border-color: transparent; }
.as-btn-ghost { background: transparent; }
.as-btn-danger { background: var(--as-danger); color: #fff; border-color: transparent; }
.as-btn-lg { min-height: 40px; padding: 10px 18px; border-radius: 10px; }
.as-btn-sm { min-height: 26px; padding: 4px 10px; font-size: 12px; }
.as-btn-block { width: 100%; }
.as-table { width: 100%; border-collapse: collapse; background: var(--as-raised); }
.as-table th, .as-table td { border: 1px solid var(--as-line); padding: 8px 10px; text-align: left; }
.as-list, .as-menu { margin: 0; padding-left: 18px; }
.as-menu { list-style: none; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.as-menu .as-btn { justify-content: flex-start; width: 100%; }
a { color: var(--as-accent); text-decoration: none; cursor: pointer; }
main, .as-panel > .as-stack { padding: 16px 20px; }
@media (max-width: 720px) {
  .as-shell, .as-split, .as-grid, .as-grid-3, .as-grid-4 { grid-template-columns: 1fr; }
}
`
}
