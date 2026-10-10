<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted, nextTick } from 'vue'
import type { ModalButtonVariant } from '../../stores/modal'

const props = defineProps<{
  open: boolean
  title: string
  message?: string
  buttons: string[]
  buttonVariants?: ModalButtonVariant[]
  input?: boolean
  inputValue?: string
  inputPlaceholder?: string
  checkbox?: boolean
  checkboxLabel?: string
  checkboxValue?: boolean
}>()

function buttonClass(index: number): string {
  const variant = props.buttonVariants?.[index] ?? (index === 0 ? 'accent' : 'default')
  if (variant === 'accent') return 'bg-accent text-accent-fg hover:opacity-90'
  if (variant === 'warning') return 'bg-semantic-warning text-white hover:opacity-90 dark:text-black'
  if (variant === 'danger') return 'bg-danger text-danger-fg hover:opacity-90'
  return 'border border-border-subtle bg-surface-base text-content-primary hover:bg-surface-overlay'
}

const emit = defineEmits<{
  close: []
  action: [index: number, inputValue?: string, checkboxValue?: boolean]
}>()

const draft = ref('')
const checked = ref(false)
const inputEl = ref<HTMLInputElement | null>(null)

watch(
  () => props.open,
  async (on) => {
    if (on) {
      draft.value = props.inputValue ?? ''
      checked.value = props.checkboxValue ?? false
      if (props.input) {
        await nextTick()
        inputEl.value?.focus()
        inputEl.value?.select()
      }
    }
  }
)

function onKeydown(e: KeyboardEvent): void {
  if (!props.open) return
  if (e.key === 'Escape') emit('close')
  if (e.key === 'Enter' && props.input) emit('action', 0, draft.value.trim(), checked.value)
}

onMounted(() => document.addEventListener('keydown', onKeydown))
onUnmounted(() => document.removeEventListener('keydown', onKeydown))
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      :aria-label="title"
      @click.self="emit('close')"
    >
      <div
        class="w-full max-w-md rounded-lg border border-border-subtle bg-surface-raised p-4 shadow-xl"
        @click.stop
      >
        <h2 class="mb-2 text-base font-semibold text-content-primary">{{ title }}</h2>
        <p v-if="message" class="mb-3 whitespace-pre-wrap text-sm text-content-secondary">{{ message }}</p>
        <input
          v-if="input"
          ref="inputEl"
          v-model="draft"
          type="text"
          class="visual-field mb-3 w-full px-3 py-2 text-sm"
          :placeholder="inputPlaceholder"
        />
        <label v-if="checkbox" class="mb-4 flex items-center gap-2 text-sm text-content-primary">
          <input v-model="checked" type="checkbox" class="rounded border-border-subtle" />
          <span>{{ checkboxLabel }}</span>
        </label>
        <div class="flex flex-wrap justify-end gap-2">
          <button
            v-for="(label, index) in buttons"
            :key="index"
            type="button"
            class="rounded-md px-3 py-1.5 text-sm transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            :class="buttonClass(index)"
            @click="emit('action', index, input ? draft.trim() : undefined, checkbox ? checked : undefined)"
          >
            {{ label }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
