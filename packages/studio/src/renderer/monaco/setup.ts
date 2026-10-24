import './fileRoot'
import * as monaco from 'monaco-editor'
import 'monaco-editor/esm/vs/basic-languages/html/html.contribution.js'
import editorWorker from './workers/editor.worker.entry?worker'
import htmlWorker from './workers/html.worker.entry?worker'
import jsonWorker from './workers/json.worker.entry?worker'
import cssWorker from './workers/css.worker.entry?worker'
import tsWorker from './workers/ts.worker.entry?worker'
import {
  agileSoflContrastFieldTheme,
  agileSoflContrastTheme,
  agileSoflDarkFieldTheme,
  agileSoflDarkTheme,
  agileSoflLightFieldTheme,
  agileSoflLightTheme,
  semanticTokenRulesForTone,
  type MonacoTone,
  type StudioMonacoTheme
} from './themes'

function withSemanticRules(
  theme: typeof agileSoflLightTheme,
  tone: MonacoTone
): typeof agileSoflLightTheme {
  return {
    ...theme,
    rules: [...theme.rules, ...semanticTokenRulesForTone(tone)]
  }
}

let initialized = false

self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    switch (label) {
      case 'json':
        return new jsonWorker()
      case 'css':
      case 'scss':
      case 'less':
        return new cssWorker()
      case 'html':
      case 'handlebars':
      case 'razor':
        return new htmlWorker()
      case 'typescript':
      case 'javascript':
        return new tsWorker()
      default:
        return new editorWorker()
    }
  }
}

export function initMonacoBase(): void {
  if (initialized) return
  initialized = true

  monaco.editor.defineTheme('agile-sofl-light', withSemanticRules(agileSoflLightTheme, 'light'))
  monaco.editor.defineTheme('agile-sofl-dark', withSemanticRules(agileSoflDarkTheme, 'dark'))
  monaco.editor.defineTheme('agile-sofl-contrast', withSemanticRules(agileSoflContrastTheme, 'contrast'))
  monaco.editor.defineTheme('agile-sofl-light-field', withSemanticRules(agileSoflLightFieldTheme, 'light'))
  monaco.editor.defineTheme('agile-sofl-dark-field', withSemanticRules(agileSoflDarkFieldTheme, 'dark'))
  monaco.editor.defineTheme('agile-sofl-contrast-field', withSemanticRules(agileSoflContrastFieldTheme, 'contrast'))

  monaco.languages.register({ id: 'agile-sofl', extensions: ['.asfl'], aliases: ['Agile-SOFL', 'ASFL'] })
  monaco.languages.register({ id: 'agile-aspec', extensions: ['.aspec'], aliases: ['Agile-ASPEC', 'Informal Spec'] })
  monaco.languages.setMonarchTokensProvider('agile-aspec', {
    tokenizer: {
      root: [
        [/^---$/, 'delimiter.yaml', '@frontmatter'],
        [/^#+\s.*$/, 'keyword'],
        [/<!--.*?-->/, 'comment'],
        [/^[\s]*[-*]\s/, 'markup'],
        [/^aspecVersion:.+$/, 'keyword'],
        [/^[\s-]*[\w]+:/, 'keyword'],
        [/.*/, 'source']
      ],
      frontmatter: [
        [/^---$/, 'delimiter.yaml', '@pop'],
        [/[\w][-\w]*:/, 'keyword'],
        [/./, 'string']
      ]
    }
  })
  monaco.languages.registerCompletionItemProvider('agile-aspec', {
    triggerCharacters: ['#', ' ', '\n'],
    provideCompletionItems: (model, position) => {
      const line = model.getLineContent(position.lineNumber)
      const suggestions = [
        { label: '# Functions', insertText: '# Functions' },
        { label: '# Data Resources', insertText: '# Data Resources' },
        { label: '# Constraints', insertText: '# Constraints' },
        { label: '## Function', insertText: '## ${1:Function title}\n\n' },
        { label: '## Data resource', insertText: '## ${1:Data resource}\n\n' },
        { label: '## Constraint', insertText: '## ${1:Constraint}\n\n' }
      ].map((item) => ({
        label: item.label,
        kind: monaco.languages.CompletionItemKind.Snippet,
        insertText: item.insertText,
        insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
        range: {
          startLineNumber: position.lineNumber,
          startColumn: 1,
          endLineNumber: position.lineNumber,
          endColumn: line.length + 1
        }
      }))
      return { suggestions }
    }
  })
}

export function applyMonacoTheme(themeName: StudioMonacoTheme): void {
  monaco.editor.setTheme(themeName)
}

export { monaco }
