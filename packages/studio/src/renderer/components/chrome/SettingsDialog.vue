<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAppStore, type ThemeMode } from '../../stores/app'
import { useSettingsStore } from '../../stores/settings'
import { ACCENT_PRESETS, normalizeHex, type AccentId, type UiZoom } from '../../lib/appearance'
import SegmentedSwitch from '../ui/SegmentedSwitch.vue'
import WorkspaceLayoutSettings from '../settings/WorkspaceLayoutSettings.vue'
import IconActionButton from '../ui/IconActionButton.vue'
import type { Locale } from '../../i18n'

type LlmPublic = {
  id: string
  name: string
  baseUrl: string
  model: string
  apiKeyMasked: string
  hasKey: boolean
  active: boolean
}

type LlmTestResult = { ok: boolean; message: string; ms: number; detail?: string }

const { t, locale } = useI18n()
const app = useAppStore()
const settings = useSettingsStore()

const section = ref<'appearance' | 'editor' | 'llm'>('appearance')
const profiles = ref<LlmPublic[]>([])
const selectedId = ref<string | null>(null)
const draftName = ref('')
const draftBaseUrl = ref('')
const draftModel = ref('')
const draftApiKey = ref('')
const jsonDump = ref('')
const importText = ref('')
const llmBusy = ref(false)
const llmMessage = ref('')
const llmOk = ref<boolean | null>(null)
const saving = ref(false)

const themeOptions = computed(() => [
  { id: 'light', label: t('settings.themeLight') },
  { id: 'dark', label: t('settings.themeDark') },
  { id: 'system', label: t('settings.themeSystem') }
])

const zoomOptions = computed(() => [
  { id: 'small', label: t('settings.zoomSmall') },
  { id: 'normal', label: t('settings.zoomNormal') },
  { id: 'large', label: t('settings.zoomLarge') },
  { id: 'xlarge', label: t('settings.zoomXLarge') }
])

const languageOptions = computed(() => [
  { id: 'zh-CN', label: t('settings.languageZh') },
  { id: 'en', label: t('settings.languageEn') }
])

const informalOptions = computed(() => [
  { id: 'document', label: t('informal.documentView') },
  { id: 'graphical', label: t('informal.graphicalView') }
])

const hybridOptions = computed(() => [
  { id: 'code', label: t('workspace.codeTab') },
  { id: 'visual', label: t('workspace.visualTab') },
  { id: 'refine', label: t('workspace.refineTab') }
])

const accentOptions = computed(() => [
  { id: 'blue' as AccentId, hex: ACCENT_PRESETS.blue.light, label: t('settings.accentBlue') },
  { id: 'green' as AccentId, hex: ACCENT_PRESETS.green.light, label: t('settings.accentGreen') },
  { id: 'orange' as AccentId, hex: ACCENT_PRESETS.orange.light, label: t('settings.accentOrange') },
  { id: 'purple' as AccentId, hex: ACCENT_PRESETS.purple.light, label: t('settings.accentPurple') },
  { id: 'yellow' as AccentId, hex: ACCENT_PRESETS.yellow.light, label: t('settings.accentYellow') },
  { id: 'red' as AccentId, hex: ACCENT_PRESETS.red.light, label: t('settings.accentRed') },
  { id: 'pink' as AccentId, hex: ACCENT_PRESETS.pink.light, label: t('settings.accentPink') },
  { id: 'custom' as AccentId, hex: '', label: t('settings.accentCustom') }
])

const selectedProfile = computed(() => profiles.value.find((p) => p.id === selectedId.value) ?? null)

const currentLocale = computed(() => (String(locale.value).startsWith('zh') ? 'zh-CN' : 'en'))

const navItems = computed(() => [
  { id: 'appearance' as const, label: t('settings.appearance') },
  { id: 'editor' as const, label: t('settings.editor') },
  { id: 'llm' as const, label: t('settings.llm') }
])

function onKeydown(e: KeyboardEvent): void {
  if (!settings.open) return
  if (e.key === 'Escape') settings.hide()
}

onMounted(() => document.addEventListener('keydown', onKeydown))
onUnmounted(() => document.removeEventListener('keydown', onKeydown))

watch(
  () => settings.open,
  (on) => {
    if (on) {
      section.value = 'appearance'
      void refreshProfiles()
    }
  }
)

function onTheme(id: string): void {
  if (id === 'light' || id === 'dark' || id === 'system') app.setTheme(id as ThemeMode)
}

function onZoom(id: string): void {
  if (id === 'small' || id === 'normal' || id === 'large' || id === 'xlarge') {
    settings.setZoom(id as UiZoom)
  }
}

function onLanguage(id: string): void {
  if (id === 'zh-CN' || id === 'en') settings.setLanguage(id as Locale)
}

function onInformal(id: string): void {
  settings.setDefaultInformalView(id === 'graphical' ? 'graphical' : 'document')
}

function onHybrid(id: string): void {
  if (id === 'code' || id === 'visual' || id === 'refine') settings.setDefaultHybridView(id)
}

function onCustomHex(value: string): void {
  settings.setCustomHex(value)
  const hex = normalizeHex(value)
  if (hex) settings.setAccentId('custom')
}

async function refreshProfiles(): Promise<void> {
  const result = await window.studio?.llmListProfiles?.()
  profiles.value = result?.profiles ?? []
  if (!selectedId.value || !profiles.value.some((p) => p.id === selectedId.value)) {
    selectedId.value = profiles.value.find((p) => p.active)?.id ?? profiles.value[0]?.id ?? null
  }
  loadSelected()
}

function loadSelected(): void {
  const profile = selectedProfile.value
  draftName.value = profile?.name ?? ''
  draftBaseUrl.value = profile?.baseUrl ?? ''
  draftModel.value = profile?.model ?? ''
  draftApiKey.value = ''
  llmMessage.value = ''
  llmOk.value = null
}

function selectProfile(id: string): void {
  selectedId.value = id
  loadSelected()
}

function newDraft(): void {
  selectedId.value = null
  draftName.value = t('settings.llmUntitled')
  draftBaseUrl.value = 'https://chat.ecnu.edu.cn/open/api/v1'
  draftModel.value = 'ecnu-max'
  draftApiKey.value = ''
  llmMessage.value = ''
  llmOk.value = null
}

async function saveProfile(): Promise<void> {
  if (!window.studio?.llmSaveProfile) return
  saving.value = true
  try {
    const result = await window.studio.llmSaveProfile({
      id: selectedId.value ?? undefined,
      name: draftName.value,
      baseUrl: draftBaseUrl.value,
      model: draftModel.value,
      apiKey: draftApiKey.value || undefined,
      activate: !selectedId.value || Boolean(selectedProfile.value?.active)
    })
    profiles.value = result.profiles
    selectedId.value = result.savedId
    draftApiKey.value = ''
    llmOk.value = true
    llmMessage.value = t('settings.llmSaved')
    loadSelected()
  } catch (error) {
    llmOk.value = false
    llmMessage.value = error instanceof Error ? error.message : String(error)
  } finally {
    saving.value = false
  }
}

async function activateProfile(): Promise<void> {
  if (!selectedId.value || !window.studio?.llmSetActiveProfile) return
  const result = await window.studio.llmSetActiveProfile(selectedId.value)
  profiles.value = result.profiles
}

async function deleteProfile(): Promise<void> {
  if (!selectedId.value || !window.studio?.llmDeleteProfile) return
  const result = await window.studio.llmDeleteProfile(selectedId.value)
  profiles.value = result.profiles
  selectedId.value = result.activeId
  if (!selectedId.value) newDraft()
  else loadSelected()
}

async function runTest(kind: 'connectivity' | 'params'): Promise<void> {
  if (!window.studio?.llmTestProfile) return
  llmBusy.value = true
  llmMessage.value = ''
  llmOk.value = null
  try {
    const result: LlmTestResult = await window.studio.llmTestProfile({
      kind,
      profileId: selectedId.value ?? undefined,
      draft: {
        baseUrl: draftBaseUrl.value,
        apiKey: draftApiKey.value || undefined,
        model: draftModel.value
      }
    })
    llmOk.value = result.ok
    llmMessage.value = result.detail
      ? `${result.message}${result.ms ? ` (${result.ms}ms)` : ''} · ${result.detail}`
      : `${result.message}${result.ms ? ` (${result.ms}ms)` : ''}`
  } catch (error) {
    llmOk.value = false
    llmMessage.value = error instanceof Error ? error.message : String(error)
  } finally {
    llmBusy.value = false
  }
}

async function dumpJson(): Promise<void> {
  jsonDump.value = (await window.studio?.llmExportProfiles?.()) ?? ''
  importText.value = jsonDump.value
}

async function importJson(): Promise<void> {
  if (!window.studio?.llmImportProfiles) return
  try {
    const result = await window.studio.llmImportProfiles(importText.value)
    profiles.value = result.profiles
    selectedId.value = result.activeId
    loadSelected()
    llmOk.value = true
    llmMessage.value = t('settings.llmImported')
  } catch (error) {
    llmOk.value = false
    llmMessage.value = error instanceof Error ? error.message : String(error)
  }
}

async function onImportFile(event: Event): Promise<void> {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return
  importText.value = await file.text()
  await importJson()
  ;(event.target as HTMLInputElement).value = ''
}

async function copyDump(): Promise<void> {
  if (!jsonDump.value) await dumpJson()
  try {
    await navigator.clipboard.writeText(jsonDump.value)
    llmOk.value = true
    llmMessage.value = t('settings.llmCopied')
  } catch {
    llmOk.value = false
    llmMessage.value = t('settings.llmCopyFailed')
  }
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="settings.open"
      class="fixed inset-0 z-[110] flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      :aria-label="t('settings.title')"
      @click.self="settings.hide()"
    >
      <div
        class="flex max-h-[min(640px,85vh)] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-border-subtle bg-surface-raised shadow-xl"
        @click.stop
      >
        <header class="flex h-11 shrink-0 items-center gap-2 border-b border-border-subtle px-4">
          <h2 class="min-w-0 flex-1 truncate text-sm font-semibold text-content-primary">{{ t('settings.title') }}</h2>
          <IconActionButton
            icon="lucide:x"
            :label="t('window.close')"
            @click="settings.hide()"
          />
        </header>
        <div class="flex min-h-0 flex-1">
          <nav class="flex w-40 shrink-0 flex-col gap-0.5 border-r border-border-subtle p-2">
            <button
              v-for="item in navItems"
              :key="item.id"
              type="button"
              class="rounded-md px-2 py-1.5 text-left text-[13px]"
              :class="
                section === item.id
                  ? 'bg-accent/15 font-medium text-accent'
                  : 'text-content-secondary hover:bg-surface-overlay hover:text-content-primary'
              "
              @click="section = item.id"
            >
              {{ item.label }}
            </button>
          </nav>
          <div class="studio-scroll min-h-0 flex-1 overflow-auto p-4">
            <section v-if="section === 'appearance'" class="flex flex-col gap-5">
              <div>
                <h3 class="mb-2 text-[12px] font-medium text-content-muted">{{ t('settings.theme') }}</h3>
                <SegmentedSwitch :model-value="app.theme" :options="themeOptions" @update:model-value="onTheme" />
              </div>
              <div>
                <h3 class="mb-2 text-[12px] font-medium text-content-muted">{{ t('settings.language') }}</h3>
                <SegmentedSwitch :model-value="currentLocale" :options="languageOptions" @update:model-value="onLanguage" />
              </div>
              <div>
                <h3 class="mb-2 text-[12px] font-medium text-content-muted">{{ t('settings.zoom') }}</h3>
                <SegmentedSwitch :model-value="settings.zoom" :options="zoomOptions" @update:model-value="onZoom" />
              </div>
              <div>
                <h3 class="mb-2 text-[12px] font-medium text-content-muted">{{ t('settings.accent') }}</h3>
                <div class="flex flex-wrap gap-2">
                  <button
                    v-for="opt in accentOptions"
                    :key="opt.id"
                    type="button"
                    class="flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[12px]"
                    :class="
                      settings.accentId === opt.id
                        ? 'border-accent bg-accent/10 text-content-primary'
                        : 'border-border-subtle text-content-secondary hover:bg-surface-overlay'
                    "
                    @click="settings.setAccentId(opt.id)"
                  >
                    <span
                      class="h-3.5 w-3.5 rounded-full border border-black/10"
                      :style="{ background: opt.id === 'custom' ? settings.customHex : opt.hex }"
                    />
                    {{ opt.label }}
                  </button>
                </div>
                <div v-if="settings.accentId === 'custom'" class="mt-2 flex items-center gap-2">
                  <input
                    type="color"
                    class="h-8 w-10 cursor-pointer rounded border border-border-subtle bg-transparent"
                    :value="normalizeHex(settings.customHex) ?? '#00668b'"
                    @input="onCustomHex(($event.target as HTMLInputElement).value)"
                  />
                  <input
                    class="visual-field w-36 px-2 py-1 text-[12px]"
                    :value="settings.customHex"
                    :placeholder="t('settings.customHex')"
                    @input="onCustomHex(($event.target as HTMLInputElement).value)"
                  />
                </div>
              </div>
              <div>
                <div class="mb-2 flex items-center justify-between">
                  <h3 class="text-[12px] font-medium text-content-muted">{{ t('settings.transparency') }}</h3>
                  <span class="text-[12px] tabular-nums text-content-secondary">{{ settings.transparency }}%</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="100"
                  class="h-1.5 w-full accent-[var(--accent)]"
                  :value="settings.transparency"
                  @input="settings.setTransparency(Number(($event.target as HTMLInputElement).value))"
                />
                <p class="mt-1.5 text-[11px] text-content-muted">{{ t('settings.transparencyHint') }}</p>
              </div>
              <WorkspaceLayoutSettings />
            </section>

            <section v-else-if="section === 'editor'" class="flex flex-col gap-5">
              <div>
                <h3 class="mb-2 text-[12px] font-medium text-content-muted">{{ t('settings.defaultInformal') }}</h3>
                <SegmentedSwitch
                  :model-value="settings.defaultInformalView"
                  :options="informalOptions"
                  @update:model-value="onInformal"
                />
              </div>
              <div>
                <h3 class="mb-2 text-[12px] font-medium text-content-muted">{{ t('settings.defaultHybrid') }}</h3>
                <SegmentedSwitch
                  :model-value="settings.defaultHybridView"
                  :options="hybridOptions"
                  @update:model-value="onHybrid"
                />
              </div>
            </section>

            <section v-else class="flex min-h-0 flex-col gap-3">
              <div class="flex gap-3">
                <div class="flex w-44 shrink-0 flex-col gap-1">
                  <button
                    v-for="profile in profiles"
                    :key="profile.id"
                    type="button"
                    class="rounded-md px-2 py-1.5 text-left text-[12px]"
                    :class="
                      selectedId === profile.id
                        ? 'bg-accent/15 text-content-primary'
                        : 'text-content-secondary hover:bg-surface-overlay'
                    "
                    @click="selectProfile(profile.id)"
                  >
                    <div class="truncate font-medium">{{ profile.name }}</div>
                    <div class="truncate text-[10px] text-content-muted">
                      {{ profile.active ? t('settings.llmActive') + ' · ' : '' }}{{ profile.model }}
                    </div>
                  </button>
                  <button
                    type="button"
                    class="mt-1 rounded-md border border-dashed border-border-subtle px-2 py-1 text-[12px] text-content-secondary hover:bg-surface-overlay"
                    @click="newDraft"
                  >
                    {{ t('settings.llmAdd') }}
                  </button>
                </div>
                <div class="flex min-w-0 flex-1 flex-col gap-2">
                  <label class="text-[11px] text-content-muted">{{ t('settings.llmName') }}</label>
                  <input v-model="draftName" class="visual-field px-2 py-1 text-[12px]" />
                  <label class="text-[11px] text-content-muted">{{ t('settings.llmBaseUrl') }}</label>
                  <input v-model="draftBaseUrl" class="visual-field px-2 py-1 text-[12px] font-mono" />
                  <label class="text-[11px] text-content-muted">{{ t('settings.llmModel') }}</label>
                  <input v-model="draftModel" class="visual-field px-2 py-1 text-[12px] font-mono" />
                  <label class="text-[11px] text-content-muted">{{ t('settings.llmApiKey') }}</label>
                  <input
                    v-model="draftApiKey"
                    type="password"
                    autocomplete="off"
                    class="visual-field px-2 py-1 text-[12px] font-mono"
                    :placeholder="
                      selectedProfile?.hasKey
                        ? t('settings.llmKeyKept', { masked: selectedProfile.apiKeyMasked })
                        : t('settings.llmKeyEmpty')
                    "
                  />
                  <div class="mt-1 flex flex-wrap gap-1.5">
                    <button
                      type="button"
                      class="rounded-md bg-accent px-2 py-1 text-[11px] font-medium text-accent-fg"
                      :disabled="saving"
                      @click="saveProfile"
                    >
                      {{ t('settings.llmSave') }}
                    </button>
                    <button
                      type="button"
                      class="rounded-md border border-border-subtle px-2 py-1 text-[11px] text-content-secondary hover:bg-surface-overlay"
                      :disabled="!selectedId"
                      @click="activateProfile"
                    >
                      {{ t('settings.llmUse') }}
                    </button>
                    <button
                      type="button"
                      class="rounded-md border border-border-subtle px-2 py-1 text-[11px] text-content-secondary hover:bg-surface-overlay"
                      :disabled="llmBusy"
                      @click="runTest('connectivity')"
                    >
                      {{ t('settings.llmTestConn') }}
                    </button>
                    <button
                      type="button"
                      class="rounded-md border border-border-subtle px-2 py-1 text-[11px] text-content-secondary hover:bg-surface-overlay"
                      :disabled="llmBusy"
                      @click="runTest('params')"
                    >
                      {{ t('settings.llmTestParams') }}
                    </button>
                    <button
                      type="button"
                      class="rounded-md px-2 py-1 text-[11px] text-danger hover:bg-surface-overlay"
                      :disabled="!selectedId"
                      @click="deleteProfile"
                    >
                      {{ t('settings.llmDelete') }}
                    </button>
                  </div>
                  <p
                    v-if="llmMessage"
                    class="text-[11px]"
                    :class="llmOk ? 'text-accent' : 'text-danger'"
                  >
                    {{ llmMessage }}
                  </p>
                </div>
              </div>
              <div class="border-t border-border-subtle pt-3">
                <h3 class="mb-2 text-[12px] font-medium text-content-muted">{{ t('settings.llmJson') }}</h3>
                <textarea
                  v-model="importText"
                  class="visual-field min-h-[88px] w-full px-2 py-1 font-mono text-[11px]"
                  :placeholder="t('settings.llmJsonHint')"
                />
                <div class="mt-2 flex flex-wrap gap-1.5">
                  <button
                    type="button"
                    class="rounded-md border border-border-subtle px-2 py-1 text-[11px] text-content-secondary hover:bg-surface-overlay"
                    @click="dumpJson"
                  >
                    {{ t('settings.llmExport') }}
                  </button>
                  <button
                    type="button"
                    class="rounded-md border border-border-subtle px-2 py-1 text-[11px] text-content-secondary hover:bg-surface-overlay"
                    @click="copyDump"
                  >
                    {{ t('settings.llmCopyJson') }}
                  </button>
                  <button
                    type="button"
                    class="rounded-md border border-border-subtle px-2 py-1 text-[11px] text-content-secondary hover:bg-surface-overlay"
                    @click="importJson"
                  >
                    {{ t('settings.llmImport') }}
                  </button>
                  <label class="cursor-pointer rounded-md border border-border-subtle px-2 py-1 text-[11px] text-content-secondary hover:bg-surface-overlay">
                    {{ t('settings.llmImportFile') }}
                    <input type="file" accept="application/json,.json" class="hidden" @change="onImportFile" />
                  </label>
                </div>
              </div>
            </section>
          </div>
        </div>
        <footer class="flex shrink-0 items-center justify-end border-t border-border-subtle px-4 py-2">
          <IconActionButton
            icon="lucide:check"
            :label="t('dialog.ok')"
            variant="accent"
            @click="settings.hide()"
          />
        </footer>
      </div>
    </div>
  </Teleport>
</template>
