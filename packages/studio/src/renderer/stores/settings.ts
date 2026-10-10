import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import {
  applyAppearance,
  clampTransparency,
  type AccentId,
  type UiZoom
} from '../lib/appearance'
import { useAppStore } from './app'
import { useWorkspaceStore } from './workspace'
import type { Locale } from '../i18n'
import {
  persistAgentWriteMode,
  readAgentWriteMode,
  type AgentWriteMode
} from '../lib/agentWriteMode'
import {
  assignPanelToSlot,
  buildDockLayout,
  DEFAULT_SLOT_PANELS,
  parseLayoutPresetId,
  parseSlotPanels,
  parseSplitRatios,
  reorderSlotPanels,
  splitPathKey,
  type SplitRatioKey,
  type WorkspaceLayoutPresetId,
  type WorkspaceSlotPanels
} from '../lib/workspaceLayout'

const ACCENT_IDS: AccentId[] = ['blue', 'green', 'orange', 'purple', 'yellow', 'red', 'pink', 'custom']
const ZOOMS: UiZoom[] = ['small', 'normal', 'large', 'xlarge']

function readAccentId(): AccentId {
  const raw = localStorage.getItem('studio-accent-id')
  return ACCENT_IDS.includes(raw as AccentId) ? (raw as AccentId) : 'blue'
}

function readZoom(): UiZoom {
  const raw = localStorage.getItem('studio-ui-zoom')
  return ZOOMS.includes(raw as UiZoom) ? (raw as UiZoom) : 'normal'
}

function readTransparency(): number {
  const raw = Number(localStorage.getItem('studio-accent-transparency'))
  return clampTransparency(Number.isFinite(raw) ? raw : 50)
}

export type InformalViewMode = 'document' | 'graphical'
export type HybridViewMode = 'code' | 'visual' | 'refine'

function readInformalDefault(): InformalViewMode {
  const raw = localStorage.getItem('studio-default-informal-view')
  return raw === 'graphical' ? 'graphical' : 'document'
}

function readHybridDefault(): HybridViewMode {
  const raw = localStorage.getItem('studio-default-hybrid-view')
  if (raw === 'code' || raw === 'refine') return raw
  return 'visual'
}

function readStoredSlotPanels(): WorkspaceSlotPanels {
  try {
    return parseSlotPanels(JSON.parse(localStorage.getItem('studio-workspace-slot-panels') ?? 'null'))
  } catch {
    return [...DEFAULT_SLOT_PANELS]
  }
}

function readStoredSplitRatios(): Record<SplitRatioKey, number> {
  try {
    return parseSplitRatios(JSON.parse(localStorage.getItem('studio-workspace-split-ratios') ?? 'null'))
  } catch {
    return {}
  }
}

export const useSettingsStore = defineStore('settings', () => {
  const open = ref(false)
  const accentId = ref<AccentId>(readAccentId())
  const customHex = ref(localStorage.getItem('studio-accent-custom') || '#00668b')
  const transparency = ref(readTransparency())
  const zoom = ref<UiZoom>(readZoom())
  const defaultInformalView = ref<InformalViewMode>(readInformalDefault())
  const defaultHybridView = ref<HybridViewMode>(readHybridDefault())
  const agentWriteMode = ref<AgentWriteMode>(
    typeof localStorage === 'undefined' ? 'ask' : readAgentWriteMode(localStorage)
  )
  const workspaceLayoutPreset = ref<WorkspaceLayoutPresetId>(
    typeof localStorage === 'undefined'
      ? 'leftTwoRightOne'
      : parseLayoutPresetId(localStorage.getItem('studio-workspace-layout-preset'))
  )
  const workspaceSlotPanels = ref<WorkspaceSlotPanels>(
    typeof localStorage === 'undefined' ? [...DEFAULT_SLOT_PANELS] : readStoredSlotPanels()
  )
  const workspaceSplitRatios = ref<Record<SplitRatioKey, number>>(
    typeof localStorage === 'undefined' ? {} : readStoredSplitRatios()
  )

  const workspaceDockLayout = computed(() =>
    buildDockLayout(workspaceLayoutPreset.value, workspaceSlotPanels.value, workspaceSplitRatios.value)
  )

  let persistTimer: ReturnType<typeof setTimeout> | null = null

  function persist(): void {
    if (persistTimer) {
      clearTimeout(persistTimer)
      persistTimer = null
    }
    localStorage.setItem('studio-accent-id', accentId.value)
    localStorage.setItem('studio-accent-custom', customHex.value)
    localStorage.setItem('studio-accent-transparency', String(transparency.value))
    localStorage.setItem('studio-ui-zoom', zoom.value)
    localStorage.setItem('studio-default-informal-view', defaultInformalView.value)
    localStorage.setItem('studio-default-hybrid-view', defaultHybridView.value)
    localStorage.setItem('studio-workspace-layout-preset', workspaceLayoutPreset.value)
    localStorage.setItem('studio-workspace-slot-panels', JSON.stringify(workspaceSlotPanels.value))
    localStorage.setItem('studio-workspace-split-ratios', JSON.stringify(workspaceSplitRatios.value))
    persistAgentWriteMode(localStorage, agentWriteMode.value)
  }

  function paint(): void {
    const app = useAppStore()
    applyAppearance({
      dark: app.isDark,
      accentId: accentId.value,
      customHex: customHex.value,
      transparency: transparency.value,
      zoom: zoom.value
    })
  }

  function setAccentId(id: AccentId): void {
    accentId.value = id
    persist()
    paint()
  }

  function setCustomHex(hex: string): void {
    customHex.value = hex
    persist()
    paint()
  }

  function setTransparency(value: number): void {
    transparency.value = clampTransparency(value)
    persist()
    paint()
  }

  function setZoom(value: UiZoom): void {
    zoom.value = value
    persist()
    paint()
  }

  function setDefaultInformalView(value: InformalViewMode): void {
    defaultInformalView.value = value
    persist()
    useWorkspaceStore().informalViewMode = value
  }

  function setDefaultHybridView(value: HybridViewMode): void {
    defaultHybridView.value = value
    persist()
    useWorkspaceStore().hybridMode = value
  }

  function setAgentWriteMode(mode: AgentWriteMode): void {
    agentWriteMode.value = mode === 'auto' ? 'auto' : 'ask'
    persist()
  }

  function setWorkspaceLayoutPreset(id: WorkspaceLayoutPresetId): void {
    workspaceLayoutPreset.value = id
    workspaceSplitRatios.value = {}
    persist()
  }

  function setWorkspaceSlotPanel(slotIndex: 0 | 1 | 2, panel: WorkspaceSlotPanels[number]): void {
    workspaceSlotPanels.value = assignPanelToSlot(workspaceSlotPanels.value, slotIndex, panel)
    persist()
  }

  function reorderWorkspaceSlots(fromIndex: number, toIndex: number): void {
    workspaceSlotPanels.value = reorderSlotPanels(workspaceSlotPanels.value, fromIndex, toIndex)
    persist()
  }

  function setWorkspaceSplitRatio(path: readonly number[], ratio: number): void {
    const key = splitPathKey(path)
    workspaceSplitRatios.value = { ...workspaceSplitRatios.value, [key]: ratio }
    if (persistTimer) clearTimeout(persistTimer)
    persistTimer = setTimeout(() => {
      persistTimer = null
      persist()
    }, 160)
  }

  function setLanguage(locale: Locale): void {
    useAppStore().setLanguage(locale)
  }

  function show(): void {
    open.value = true
  }

  function hide(): void {
    open.value = false
  }

  function init(): void {
    paint()
    const app = useAppStore()
    watch(
      () => app.isDark,
      () => paint()
    )
  }

  if (typeof document !== 'undefined') {
    paint()
  }

  return {
    open,
    accentId,
    customHex,
    transparency,
    zoom,
    defaultInformalView,
    defaultHybridView,
    agentWriteMode,
    workspaceLayoutPreset,
    workspaceSlotPanels,
    workspaceDockLayout,
    setWorkspaceLayoutPreset,
    setWorkspaceSlotPanel,
    reorderWorkspaceSlots,
    setWorkspaceSplitRatio,
    setAccentId,
    setCustomHex,
    setTransparency,
    setZoom,
    setDefaultInformalView,
    setDefaultHybridView,
    setAgentWriteMode,
    setLanguage,
    show,
    hide,
    init
  }
})
