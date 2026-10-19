# @agile-sofl/studio

Electron + Vue visual editor for Agile-SOFL specifications.

## Features

- Frameless custom title bar (File / Edit / View / Help menus, window controls)
- **Home tab** on startup with New / Open and recent files list
- **New file templates**: blank, minimal module, and curated examples (library, ecommerce, etc.)
- Multi-tab `.asfl` editor with New / Open / Save / Save As
- **Default split view**: Monaco + visual editor side by side
- **Visual editor (Phase 2a)**: module tree, declaration overview, FSF scenario forms with live code sync
- **Editor toolbar**: split / code / visual modes; minimap and line number toggles
- Monaco TextMate syntax highlighting (scope map → theme tokens; Monarch fallback)
- LSP via multi-strategy spawn (utilityProcess → Node → Electron-as-Node)
- Help → Developer Tools (`Ctrl+Shift+I`)
- Light / dark / system theme
- i18n: 简体中文 + English

## Quick start (Windows)

From repository root, run `studio.bat` — it builds parser + language server bundle, then starts the dev app:

```bat
studio.bat
```

## Development

From repository root:

```bash
npm install
npm run build --workspace @agile-sofl/parser
npm run build --workspace @agile-sofl/language-server
npm run bundle --workspace @agile-sofl/language-server
npm run dev --workspace @agile-sofl/studio
```

## Architecture

| Layer | Role |
|-------|------|
| Main | File dialogs, LSP stdio spawn + Content-Length IPC bridge, window controls |
| Preload | Typed `window.studio` API |
| Renderer | Vue 3 + Pinia + Tailwind + Monaco + monaco-languageclient + `@agile-sofl/editor-api` |

See [docs/12-Electron编辑器集成.md](../../docs/12-Electron编辑器集成.md), [docs/14-Studio-UI设计规约.md](../../docs/14-Studio-UI设计规约.md), and [docs/15-Studio可视化编辑器.md](../../docs/15-Studio可视化编辑器.md).


## Links and bidirectional updates

Open the **Links / 关联** entry in either Informal or Hybrid. Add manual links or find AI candidates, inspect changes, and preview updates in either direction before applying. Shared declarations show their affected processes; edits and link metadata share the global undo stack. Saving a file does not acknowledge an unchecked change.

Manual links, navigation, and local change detection work without an LLM. AI recovery and update suggestions use the configured Studio model. The project-wide graph is stored in `.agile-sofl/trace/workspace-v3.json`; keep the trace directory with the project for restart recovery. Links span specification files and survive unambiguous moves. The panel includes reviewed split/merge, exact evidence, constraint inspection, an optional link map, bulk review, snapshot comparison and interrupted-update recovery. Document headings and code lenses provide direct navigation.

See [Trace 关联与双向联动](../../docs/26-Trace关联与双向联动.md) for current behavior, validation, and the design for multi-file tracing, split/merge, evidence, evaluation, and collaboration.
