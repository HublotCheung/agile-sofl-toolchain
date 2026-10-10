<script setup lang="ts">
import { ref, computed, onUnmounted } from 'vue'

const props = withDefaults(
  defineProps<{
    widths: number[]
    collapsed?: boolean[]
    min?: number
  }>(),
  { collapsed: () => [], min: 0.08 }
)

const emit = defineEmits<{ 'update:widths': [value: number[]] }>()

const container = ref<HTMLElement | null>(null)

type DragState = {
  index: number
  pointerId: number
  startX: number
  startWidths: number[]
  pairTotal: number
  total: number
  available: number
}

const drag = ref<DragState | null>(null)
const count = computed(() => props.widths.length)

function isCollapsed(index: number): boolean {
  return Boolean(props.collapsed[index])
}

function totalWeight(widths: number[]): number {
  return widths.reduce((sum, w, idx) => sum + (isCollapsed(idx) ? 0 : w), 0)
}

/** Flex grow share among visible columns (collapsed columns are not mounted). */
function flexGrow(index: number): number {
  const total = totalWeight(props.widths)
  if (total <= 0) return 1
  return (props.widths[index] ?? 0) / total
}

function showGutterAfter(leftIndex: number): boolean {
  const rightIndex = leftIndex + 1
  if (rightIndex >= count.value) return false
  return !isCollapsed(leftIndex) && !isCollapsed(rightIndex)
}

function visibleGutterCount(): number {
  let n = 0
  for (let i = 0; i < count.value - 1; i++) {
    if (showGutterAfter(i)) n++
  }
  return n
}

function gutterWidthPx(): number {
  const el = container.value
  if (!el) return 12
  const gutter = el.querySelector<HTMLElement>('[data-resize-gutter]')
  return gutter?.getBoundingClientRect().width || 12
}

function availableWidth(): number {
  const el = container.value
  if (!el) return 0
  const gutters = visibleGutterCount() * gutterWidthPx()
  return Math.max(0, el.getBoundingClientRect().width - gutters)
}

function applyDelta(clientX: number): void {
  const d = drag.value
  if (!d || d.available <= 0 || d.total <= 0) return

  const deltaWeight = ((clientX - d.startX) / d.available) * d.total
  const min = props.min
  let nextLeft = (d.startWidths[d.index] ?? 0) + deltaWeight
  nextLeft = Math.max(min, Math.min(d.pairTotal - min, nextLeft))

  const next = [...d.startWidths]
  next[d.index] = nextLeft
  next[d.index + 1] = d.pairTotal - nextLeft
  emit('update:widths', next)
}

function onPointerDown(index: number, e: PointerEvent): void {
  if (e.button !== 0 || !container.value) return
  if (isCollapsed(index) || isCollapsed(index + 1)) return
  e.preventDefault()
  e.stopPropagation()

  const startWidths = [...props.widths]
  drag.value = {
    index,
    pointerId: e.pointerId,
    startX: e.clientX,
    startWidths,
    pairTotal: (startWidths[index] ?? 0) + (startWidths[index + 1] ?? 0),
    total: totalWeight(startWidths),
    available: availableWidth()
  }

  const target = e.currentTarget as HTMLElement
  target.setPointerCapture(e.pointerId)
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
}

function onPointerMove(e: PointerEvent): void {
  if (!drag.value || e.pointerId !== drag.value.pointerId) return
  applyDelta(e.clientX)
}

function endDrag(e: PointerEvent): void {
  if (!drag.value || e.pointerId !== drag.value.pointerId) return
  const target = e.currentTarget as HTMLElement
  if (target.hasPointerCapture(e.pointerId)) target.releasePointerCapture(e.pointerId)
  drag.value = null
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
}

onUnmounted(() => {
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
})
</script>

<template>
  <div ref="container" class="flex h-full min-h-0 w-full min-w-0">
    <template v-for="i in count" :key="i">
      <div
        v-show="!isCollapsed(i - 1)"
        class="relative min-h-0 min-w-0 overflow-hidden"
        :style="{ flex: `${flexGrow(i - 1)} 1 0%`, minWidth: '0px' }"
      >
        <slot :name="`col-${i - 1}`" />
      </div>
      <div
        v-if="i < count && showGutterAfter(i - 1)"
        data-resize-gutter
        class="group/resize relative z-20 flex w-3 shrink-0 touch-none items-center justify-center"
      >
        <div
          class="absolute inset-0 z-[1] cursor-col-resize"
          @pointerdown="onPointerDown(i - 1, $event)"
          @pointermove="onPointerMove"
          @pointerup="endDrag"
          @pointercancel="endDrag"
        />
        <div
          class="pointer-events-none absolute inset-y-0 left-1/2 z-[2] w-1 -translate-x-1/2 bg-border-subtle transition-colors duration-150 group-hover/resize:bg-accent/40"
          :class="{ 'bg-accent/40': drag?.index === i - 1 }"
        />
        <slot :name="`bar-${i - 1}`" />
      </div>
    </template>
  </div>
</template>
