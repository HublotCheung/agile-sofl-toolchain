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

To create the distributable Windows installer, run `package-studio-win.bat` from the repository root. It installs the locked workspace dependencies and writes the NSIS installer to `packages/studio/release/`. The installer bundles the Studio project templates and language server.

On first launch, Studio opens a setup screen for language, theme, and an optional OpenAI-compatible LLM profile. Users can skip LLM setup and add it later from Settings.

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

Agent modeling applies specifications and their source bindings together. Related nodes show a small ↔ marker; an upstream edit adds an amber dot on the receiving side. Open it for **Got it / Edit manually / AI edit**. AI changes are previewed before applying; text and bindings share the global undo stack. Acknowledgement dismisses only that upstream version and does not claim consistency.

Navigation and local change detection work without an LLM. Existing projects can recover connections on request; new Agent modeling records them as part of the modeling operation, with missing or ambiguous origins rejected before writing text. AI suggestions use the configured Studio model. The graph is stored in `.agile-sofl/trace/workspace-v3.json`; keep this directory for restart recovery. File moves and explicit renames retain identities when unambiguous. Advanced trace services remain internal rather than exposing a relationship-management toolbar.

See [Trace 关联与双向联动](../../docs/26-Trace关联与双向联动.md) for current behavior, validation, and the design for multi-file tracing, split/merge, evidence, evaluation, and collaboration.
