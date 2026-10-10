<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useAppStore } from '../../stores/app'

const app = useAppStore()
const isMax = ref(false)

onMounted(async () => {
  isMax.value = await window.studio!.isMaximized()
})

async function minimize(): Promise<void> {
  await window.studio!.minimize()
}

async function toggleMaximize(): Promise<void> {
  isMax.value = await window.studio!.maximize()
}

function close(): void {
  window.studio!.close()
}
</script>

<template>
  <div class="titlebar-no-drag flex h-full items-stretch">
    <button
      type="button"
      class="flex w-[46px] items-center justify-center text-content-secondary transition-colors duration-150 hover:bg-surface-overlay hover:text-content-primary active:scale-[0.98]"
      :title="$t('window.minimize')"
      @click="minimize"
    >
      <svg width="10" height="1" viewBox="0 0 10 1"><rect width="10" height="1" fill="currentColor" /></svg>
    </button>
    <button
      type="button"
      class="flex w-[46px] items-center justify-center text-content-secondary transition-colors duration-150 hover:bg-surface-overlay hover:text-content-primary active:scale-[0.98]"
      :title="isMax || app.isMaximized ? $t('window.restore') : $t('window.maximize')"
      @click="toggleMaximize"
    >
      <svg v-if="!(isMax || app.isMaximized)" width="10" height="10" viewBox="0 0 10 10">
        <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" />
      </svg>
      <svg v-else width="10" height="10" viewBox="0 0 10 10">
        <rect x="2" y="0.5" width="7.5" height="7.5" fill="none" stroke="currentColor" />
        <rect x="0.5" y="2" width="7.5" height="7.5" fill="var(--surface-raised)" stroke="currentColor" />
      </svg>
    </button>
    <button
      type="button"
      class="flex w-[46px] items-center justify-center text-content-secondary transition-colors duration-150 hover:bg-danger hover:text-danger-fg active:scale-[0.98]"
      :title="$t('window.close')"
      @click="close"
    >
      <svg width="10" height="10" viewBox="0 0 10 10">
        <path d="M1 1 L9 9 M9 1 L1 9" stroke="currentColor" stroke-width="1.2" />
      </svg>
    </button>
  </div>
</template>
