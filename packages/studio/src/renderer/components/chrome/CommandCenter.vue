<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { useCommandCenterStore } from '../../stores/commandCenter'
import CommandCenterPanel from './CommandCenterPanel.vue'

const { t } = useI18n()
const center = useCommandCenterStore()

function open(): void {
  center.open()
}
</script>

<template>
  <div class="flex h-full w-full items-center justify-center px-4">
    <button
      type="button"
      class="studio-command-trigger titlebar-no-drag flex h-[22px] max-w-md flex-1 items-center gap-2 rounded-md border border-border-subtle bg-surface-base/50 px-3 text-xs text-content-muted transition-colors duration-150 hover:border-accent/40 hover:text-content-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
      @click="open"
    >
      <svg class="h-3.5 w-3.5 shrink-0 opacity-60" viewBox="0 0 16 16" fill="none">
        <circle cx="7" cy="7" r="4.5" stroke="currentColor" stroke-width="1.2" />
        <path
          d="M10.5 10.5 L14 14"
          stroke="currentColor"
          stroke-width="1.2"
          stroke-linecap="round"
        />
      </svg>
      <span class="truncate">{{ t('commandCenter.search') }}</span>
      <span class="ml-auto shrink-0 text-[10px] opacity-60">Ctrl+P</span>
    </button>
    <CommandCenterPanel />
  </div>
</template>
