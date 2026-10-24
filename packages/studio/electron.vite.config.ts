import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import monacoNlsAdapter from 'monaco-editor-nls-adapter'
import type { Plugin } from 'vite'

const monacoNlsPlugin = monacoNlsAdapter.vitePlugin
import { resolve } from 'node:path'

function removeCrossorigin(): Plugin {
  return {
    name: 'remove-crossorigin',
    transformIndexHtml(html) {
      return html.replace(/\s+crossorigin(="[^"]*")?/gi, '')
    }
  }
}

const monorepoExternals = [
  '@agile-sofl/parser',
  '@agile-sofl/gui',
  '@agile-sofl/editor-api',
  '@agile-sofl/language-server'
]

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts')
        },
        external: monorepoExternals
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts')
        }
      }
    }
  },
  renderer: {
    base: './',
    root: resolve(__dirname, 'src/renderer'),
    publicDir: resolve(__dirname, 'public'),
    server: {
      // A production preview inlines Monaco as a data URL and the workspace never mounts.
      // Dev keeps the real Monaco URL. Capture turns HMR off so a save cannot wipe the window.
      hmr: process.env.STUDIO_CAPTURE === '1' ? false : undefined,
      sourcemapIgnoreList(sourcePath) {
        return sourcePath.replace(/\\/g, '/').includes('monaco-editor')
      }
    },
    resolve: {
      alias: {
        '@agile-sofl/editor-api': resolve(__dirname, 'src/renderer/lib/editorApiRenderer.ts'),
        // Main process loads CJS from dist; renderer bundles ESM from source.
        '@agile-sofl/gui': resolve(__dirname, '../gui/src/index.ts'),
        'monaco-editor-nls-adapter/proxy': resolve(__dirname, 'src/renderer/monaco/nlsProxy.js'),
        echarts: resolve(__dirname, '../../node_modules/echarts')
      }
    },
    build: {
      modulePreload: {
        polyfill: false
      },
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html')
        }
      }
    },
    plugins: [vue(), monacoNlsPlugin({ languages: ['zh-hans'] }), removeCrossorigin()],
    css: {
      postcss: resolve(__dirname, 'postcss.config.cjs')
    },
    worker: {
      format: 'es'
    },
    // Exclude monaco-editor from prebundle so monacoNlsPlugin can inject zh-hans at dev time.
    // Clear node_modules/.vite after changing this if context menu stays English.
    optimizeDeps: {
      exclude: ['monaco-editor'],
      include: ['vditor', 'echarts', 'zrender']
    }
  }
})
