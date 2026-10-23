<script setup lang="ts">
import { onMounted, ref } from 'vue'
import EditorLayout from './layouts/EditorLayout.vue'
import FirstRunSetup from './components/onboarding/FirstRunSetup.vue'
import { useAppStore } from './stores/app'
import { useDocumentStore } from './stores/document'
import { useLspStore } from './stores/lsp'
import { useWorkspaceStore } from './stores/workspace'
import { useSettingsStore } from './stores/settings'
import { initLocaleFromSystem } from './i18n'

const app = useAppStore()
const doc = useDocumentStore()
const lsp = useLspStore()
const workspace = useWorkspaceStore()
const settings = useSettingsStore()
const showFirstRunSetup = ref(
  localStorage.getItem('studio-setup-complete') !== 'true' && !localStorage.getItem('studio-locale')
)

onMounted(async () => {
  await initLocaleFromSystem()
  await app.init()
  settings.init()
  await window.studio?.whenBackendReady?.()
  const opened = await workspace.init()
  if (!opened && !doc.restoreFromSession()) {
    doc.initHome()
  }
  doc.saveSession()
  lsp.init()
})

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    doc.saveSession()
  })
}
</script>

<template>
  <EditorLayout />
  <FirstRunSetup v-if="showFirstRunSetup" @complete="showFirstRunSetup = false" />
</template>
