import { defineStore } from 'pinia'
import { ref } from 'vue'

export const useLspStore = defineStore('lsp', () => {
  const running = ref(false)
  const errorCount = ref(0)
  const message = ref('')
  let clientStarted = false
  let unsubStatus: (() => void) | undefined

  async function refresh(): Promise<void> {
    const status = await window.studio?.getLspStatus()
    if (status) {
      running.value = status.running
      message.value = status.message
    }
  }

  async function ensureClient(): Promise<void> {
    if (clientStarted || !running.value) return
    try {
      const { startLanguageClient } = await import('../monaco/languageClient')
      await startLanguageClient()
      clientStarted = true
    } catch (err) {
      console.error('[studio] language client failed to start:', err)
      message.value = 'Language client failed to start — see DevTools console'
    }
  }

  function init(): void {
    refresh()
    unsubStatus = window.studio?.lspOnStatusChanged(async (s) => {
      running.value = s.running
      if (s.message) message.value = s.message
      if (s.running) {
        if (!s.message) message.value = 'Language server connected'
        await ensureClient()
      } else {
        if (!s.message) message.value = 'Language server disconnected'
        clientStarted = false
      }
    })
    if (running.value) void ensureClient()
  }

  function dispose(): void {
    unsubStatus?.()
  }

  function setErrorCount(count: number): void {
    errorCount.value = count
  }

  return { running, errorCount, message, refresh, init, dispose, setErrorCount, ensureClient }
})
