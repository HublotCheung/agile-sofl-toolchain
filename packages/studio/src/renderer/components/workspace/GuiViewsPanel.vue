<script setup lang="ts">
import { computed, inject, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { extractScreenHtml } from '@agile-sofl/gui'
import { GUI_MODEL_KEY } from '../../composables/guiModelContext'
import { useWorkspaceStore } from '../../stores/workspace'
import { filePathsEqual } from '../../stores/tabUtils'
import { resolveGuiScreenId } from '../../lib/guiNavigate'
import GuiDesignerCanvas from '../editor/gui/GuiDesignerCanvas.vue'
import GuiScreenSource from '../editor/gui/GuiScreenSource.vue'
import DockPanelChrome from './dock/DockPanelChrome.vue'
import FullscreenPanel from './FullscreenPanel.vue'
import SegmentedSwitch from '../ui/SegmentedSwitch.vue'

const { t } = useI18n()
const workspace = useWorkspaceStore()
const gui = inject(GUI_MODEL_KEY)
if (!gui) throw new Error('GuiViewsPanel requires GUI_MODEL_KEY')

const selectedViewId = ref<string | null>(null)
const screenDraft = ref('')
const pushing = ref(false)
let draftTimer: ReturnType<typeof setTimeout> | null = null

const screens = computed(() => gui.model.value?.screens ?? [])
const fullHtml = computed(() => gui.model.value?.html ?? '')
const guiViewOptions = computed(() => [
  { id: 'code', label: t('workspace.codeTab') },
  { id: 'visual', label: t('workspace.visualTab') }
])
const codeActive = computed(() => workspace.guiMode === 'code')
const selectedScreen = computed(() => {
  const id = resolveGuiScreenId(screens.value, selectedViewId.value)
  return screens.value.find((s) => s.id === id) ?? null
})
const screenFileName = computed(() =>
  selectedScreen.value ? `${selectedScreen.value.name}.html` : ''
)

function syncDraftFromModel(): void {
  const screen = selectedScreen.value
  if (!screen) {
    screenDraft.value = ''
    return
  }
  const next =
    extractScreenHtml(fullHtml.value, screen.id) || extractScreenHtml(fullHtml.value, screen.name)
  if (next !== screenDraft.value) screenDraft.value = next
}

function onGuiMode(id: string): void {
  workspace.guiMode = id === 'code' ? 'code' : 'visual'
  if (id === 'code') {
    workspace.setFocusedPanel('gui')
    syncDraftFromModel()
  }
}

function selectScreen(id: string): void {
  if (draftTimer) {
    clearTimeout(draftTimer)
    draftTimer = null
    const prev = selectedScreen.value?.id
    if (prev) void commitScreenHtml(screenDraft.value, prev)
  }
  selectedViewId.value = resolveGuiScreenId(screens.value, id) ?? id
}

function onScreenHtmlEdit(value: string): void {
  screenDraft.value = value
  const screenId = selectedScreen.value?.id
  if (draftTimer) clearTimeout(draftTimer)
  draftTimer = setTimeout(() => {
    void commitScreenHtml(value, screenId)
  }, 300)
}

async function commitScreenHtml(value: string, screenId?: string): Promise<void> {
  const id = screenId ?? selectedScreen.value?.id
  if (!id || pushing.value) return
  const current = extractScreenHtml(fullHtml.value, id)
  if (value === current) return
  pushing.value = true
  try {
    await gui.replaceScreenHtml(id, value)
  } finally {
    pushing.value = false
  }
}

async function addView(): Promise<void> {
  const id = `view-${Math.random().toString(36).slice(2, 8)}`
  await gui.addScreen({
    id,
    name: `View${screens.value.length + 1}`,
    title: t('gui.newScreen'),
    widgets: []
  })
  selectedViewId.value = id
}

watch(
  screens,
  (list) => {
    if (!list.length) {
      selectedViewId.value = null
      return
    }
    const resolved = resolveGuiScreenId(list, selectedViewId.value)
    selectedViewId.value = resolved ?? list[0]!.id
  },
  { immediate: true }
)

watch(
  () => workspace.guiRevealNonce,
  () => {
    const id = workspace.guiRevealScreenId
    if (id) selectScreen(id)
  }
)

watch(
  () => workspace.editorRevealNonce,
  () => {
    const request = workspace.editorReveal
    if (!request || request.kind !== 'guispec') return
    const tab = workspace.guiTab
    if (!tab?.filePath || !filePathsEqual(tab.filePath, request.filePath)) return
    const html = gui.model.value?.html || tab.content
    const hit = screens.value.find((screen) => {
      const chunk = extractScreenHtml(html, screen.id) || extractScreenHtml(html, screen.name)
      return chunk.includes(request.text)
    })
    if (hit) selectScreen(hit.id)
  }
)

watch(
  [fullHtml, selectedViewId],
  () => {
    if (!codeActive.value) return
    syncDraftFromModel()
  }
)

watch(codeActive, (on) => {
  if (on) void nextTick(() => syncDraftFromModel())
})
</script>

<template>
  <FullscreenPanel panel-id="gui">
    <section class="flex h-full min-h-0 flex-col border-t border-border-subtle bg-surface-base">
      <DockPanelChrome panel="gui" :title="t('workspace.guiViews')" :dirty="workspace.isGuiDirty()">
        <template #actions>
          <SegmentedSwitch
            class="min-w-0 shrink"
            :model-value="workspace.guiMode"
            :options="guiViewOptions"
            @update:model-value="onGuiMode"
          />
        </template>
      </DockPanelChrome>
      <div class="relative min-h-0 flex-1 overflow-hidden">
        <div
          class="absolute inset-0"
          :class="workspace.guiMode === 'visual' ? 'z-10' : 'hidden'"
        >
          <GuiDesignerCanvas
            :selected-view-id="selectedViewId"
            @update:selected-view-id="selectScreen"
          />
        </div>
        <div
          class="absolute inset-0 flex"
          :class="codeActive ? 'z-10' : 'invisible pointer-events-none z-0'"
        >
          <aside class="flex w-44 shrink-0 flex-col border-r border-border-subtle">
            <div class="flex items-center justify-between px-2 py-1 text-[11px] text-content-secondary">
              <span>{{ t('gui.screens') }}</span>
              <button type="button" class="rounded px-1 hover:bg-surface-overlay" @click="addView">+</button>
            </div>
            <ul class="studio-scroll min-h-0 flex-1 overflow-auto px-1 pb-1">
              <li v-for="screen in screens" :key="screen.id">
                <button
                  type="button"
                  class="mb-0.5 w-full rounded px-2 py-1.5 text-left text-xs"
                  :class="
                    screen.id === selectedScreen?.id
                      ? 'bg-accent/15 text-accent'
                      : 'hover:bg-surface-overlay'
                  "
                  @click="selectScreen(screen.id)"
                >
                  <span class="block">{{ screen.title || screen.name }}</span>
                  <span class="font-mono text-[10px] text-content-muted">{{ screen.name }}.html</span>
                </button>
              </li>
            </ul>
          </aside>
          <div class="min-h-0 min-w-0 flex-1">
            <GuiScreenSource
              v-if="selectedScreen"
              :model-value="screenDraft"
              :file-name="screenFileName"
              @update:model-value="onScreenHtmlEdit"
            />
            <p v-else class="p-4 text-sm text-content-secondary">
              {{ t('workspace.guiCodeMissing') }}
            </p>
          </div>
        </div>
      </div>
    </section>
  </FullscreenPanel>
</template>
