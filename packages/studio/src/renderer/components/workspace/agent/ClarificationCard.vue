<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { composeClarificationAnswer, encodeClarificationAnswer } from '../../../../shared/clarificationAnswer'

const props = defineProps<{
  question: string
  options?: Array<{ id: string; label: string }>
  allowCustom?: boolean
  multiSelect?: boolean
  disabled?: boolean
  pending?: boolean
  answer?: string
  expanded?: boolean
  prefillIds?: string[]
  prefillCustom?: string
}>()

const emit = defineEmits<{
  submit: [value: string]
  change: [optionId: string]
  toggle: []
  draft: [draft: { ids: string[]; custom: string }]
}>()
const selected = ref<string[]>([])
const custom = ref('')

const canSubmit = computed(
  () => selected.value.length > 0 || (props.allowCustom !== false && custom.value.trim())
)

function answerParts(): string[] {
  return (props.answer ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
}

function isChosen(opt: { id: string; label: string }): boolean {
  if (props.pending) return selected.value.includes(opt.id)
  return answerParts().includes(opt.label)
}

function toggle(id: string): void {
  if (props.multiSelect) {
    selected.value = selected.value.includes(id)
      ? selected.value.filter((x) => x !== id)
      : [...selected.value, id]
    return
  }
  selected.value = [id]
}

function submit(): void {
  const labels = (props.options ?? [])
    .filter((o) => selected.value.includes(o.id))
    .map((o) => o.label)
  const composed = composeClarificationAnswer({
    selectedLabels: labels,
    custom: custom.value,
    multiSelect: props.multiSelect
  })
  if (!composed.answer) return
  emit('submit', encodeClarificationAnswer(composed))
}

function onCustomKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229) return
  event.preventDefault()
  submit()
}

watch(
  () => (props.pending ? props.prefillIds : undefined),
  (ids) => {
    if (!props.pending || ids === undefined) return
    selected.value = [...ids]
    if (props.prefillCustom !== undefined) custom.value = props.prefillCustom
  },
  { immediate: true }
)

watch([selected, custom], () => {
  if (!props.pending) return
  emit('draft', { ids: [...selected.value], custom: custom.value })
})

function onOptionClick(opt: { id: string; label: string }): void {
  if (props.disabled) return
  if (props.pending) {
    toggle(opt.id)
    return
  }
  emit('change', opt.id)
}
</script>

<template>
  <div class="agent-bubble mt-1 min-w-0 max-w-full overflow-hidden rounded-lg bg-surface-raised">
    <button
      type="button"
      class="flex w-full items-start gap-2 px-2 py-1 text-left hover:bg-surface-overlay"
      :aria-expanded="expanded"
      :title="answer ? `${question} — ${answer}` : question"
      @click="emit('toggle')"
    >
      <span class="studio-text-selectable min-w-0 flex-1">
        <span class="block truncate text-[12px] font-medium leading-snug text-content-primary">{{ question }}</span>
        <span
          v-if="answer && !expanded"
          class="block truncate text-[12px] font-normal leading-snug text-content-secondary"
        >{{ answer }}</span>
      </span>
      <span
        class="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border border-border-subtle text-[11px] leading-none text-content-secondary"
        aria-hidden="true"
      >{{ expanded ? '▾' : '▸' }}</span>
      <span class="sr-only">{{ expanded ? $t('agent.collapse') : $t('agent.expand') }}</span>
    </button>
    <div v-if="expanded" class="min-w-0 border-t border-border-subtle px-2 pb-2 pt-1.5">
      <div v-if="options?.length" class="flex min-w-0 flex-col gap-1">
        <button
          v-for="opt in options"
          :key="opt.id"
          type="button"
          class="max-w-full min-w-0 truncate rounded-md border px-2 py-0.5 text-left text-[12px] leading-snug transition-colors"
          :class="
            isChosen(opt)
              ? 'border-accent bg-accent/10 text-content-primary'
              : 'border-border-subtle text-content-secondary hover:border-accent/50 hover:text-content-primary'
          "
          :title="opt.label"
          :disabled="disabled"
          @click="onOptionClick(opt)"
        >
          {{ opt.label }}
        </button>
      </div>
      <div v-if="pending && allowCustom !== false" class="mt-1.5">
        <input
          v-model="custom"
          class="w-full rounded-md border border-field-border bg-field-bg px-2 py-1 text-[12px] text-content-primary outline-none focus:ring-2 focus:ring-accent/30"
          :placeholder="$t('agent.customAnswer')"
          :disabled="disabled"
          @keydown="onCustomKeydown"
        />
      </div>
      <p
        v-if="!pending && answer"
        class="studio-text-selectable mt-1.5 min-w-0 truncate rounded-md bg-surface-base px-2 py-1 text-[12px] text-content-secondary"
        :title="answer"
      >
        {{ $t('agent.yourAnswer') }}：{{ answer }}
      </p>
      <button
        v-if="pending"
        type="button"
        class="mt-1.5 rounded-md bg-accent px-2.5 py-1 text-[12px] font-medium text-accent-fg disabled:opacity-40"
        :disabled="disabled || !canSubmit"
        @click="submit"
      >
        {{ $t('agent.confirm') }}
      </button>
    </div>
  </div>
</template>
