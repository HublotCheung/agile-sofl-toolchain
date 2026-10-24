<script setup lang="ts">
import { computed } from 'vue'
import { useAppStore } from '../../stores/app'
import MenuBar from './MenuBar.vue'
import CommandCenter from './CommandCenter.vue'
import WindowControls from './WindowControls.vue'

defineEmits<{ edit: [cmd: string]; devTools: []; format: []; refine: [] }>()

const app = useAppStore()
const isDarwin = computed(() => app.platform === 'darwin')
</script>

<template>
  <header
    class="titlebar-drag flex h-[35px] shrink-0 items-center border-b border-titlebar-border bg-titlebar select-none"
  >
    <div
      class="titlebar-no-drag flex items-center gap-2"
      :class="isDarwin ? 'pl-[78px]' : 'pl-2'"
    >
      <img
        src="/logo.png"
        alt=""
        class="h-[18px] w-[18px] shrink-0 object-contain"
        draggable="false"
      />
      <MenuBar @edit="$emit('edit', $event)" @dev-tools="$emit('devTools')" @format="$emit('format')" @refine="$emit('refine')" />
    </div>

    <div class="titlebar-drag flex min-w-0 flex-1 items-center justify-center">
      <CommandCenter />
    </div>

    <WindowControls />
  </header>
</template>
