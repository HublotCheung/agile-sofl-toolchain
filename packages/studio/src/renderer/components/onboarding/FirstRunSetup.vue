<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAppStore, type ThemeMode } from '../../stores/app'
import type { Locale } from '../../i18n'

const emit = defineEmits<{ complete: [] }>()
const { t } = useI18n()
const app = useAppStore()
const language = ref(String(localStorage.getItem('studio-locale') || 'zh-CN'))
const theme = ref<ThemeMode>(app.theme)
const providerName = ref('')
const baseUrl = ref('')
const model = ref('')
const apiKey = ref('')
const saving = ref(false)
const error = ref('')

const llmFieldsFilled = computed(() => [providerName.value, baseUrl.value, model.value, apiKey.value].some((value) => value.trim()))
const llmFieldsComplete = computed(() => [providerName.value, baseUrl.value, model.value, apiKey.value].every((value) => value.trim()))

function selectLanguage(value: string): void {
  if (!['zh-CN', 'zh-TW', 'ja', 'en'].includes(value)) return
  language.value = value
  app.setLanguage(value as Locale)
}

function selectTheme(value: ThemeMode): void {
  theme.value = value
  app.setTheme(value)
}

function finish(): void {
  localStorage.setItem('studio-setup-complete', 'true')
  emit('complete')
}

async function completeSetup(): Promise<void> {
  error.value = ''
  if (llmFieldsFilled.value && !llmFieldsComplete.value) {
    error.value = t('onboarding.llmRequired')
    return
  }
  if (llmFieldsComplete.value) {
    if (!window.studio?.llmSaveProfile) {
      error.value = t('onboarding.saveError')
      return
    }
    saving.value = true
    try {
      await window.studio.llmSaveProfile({
        name: providerName.value.trim(),
        baseUrl: baseUrl.value.trim(),
        model: model.value.trim(),
        apiKey: apiKey.value,
        activate: true
      })
    } catch (err) {
      error.value = err instanceof Error ? err.message : t('onboarding.saveError')
      return
    } finally {
      saving.value = false
    }
  }
  finish()
}
</script>

<template>
  <div class="fixed inset-0 z-[150] flex items-center justify-center bg-black/55 p-4" role="dialog" aria-modal="true" :aria-label="t('onboarding.title')">
    <section class="max-h-[min(760px,92vh)] w-full max-w-2xl overflow-y-auto rounded-2xl border border-border-subtle bg-surface-raised p-6 shadow-2xl sm:p-8">
      <div class="mb-6">
        <p class="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-accent">Agile-SOFL Studio</p>
        <h1 class="text-2xl font-semibold text-content-primary">{{ t('onboarding.title') }}</h1>
        <p class="mt-2 text-sm text-content-secondary">{{ t('onboarding.subtitle') }}</p>
      </div>

      <div class="space-y-6">
        <section>
          <h2 class="mb-2 text-sm font-semibold text-content-primary">{{ t('onboarding.language') }}</h2>
          <select class="visual-field w-full px-3 py-2 text-sm" :value="language" @change="selectLanguage(($event.target as HTMLSelectElement).value)">
            <option value="zh-CN">简体中文</option>
            <option value="zh-TW">繁體中文</option>
            <option value="en">English</option>
            <option value="ja">日本語</option>
          </select>
        </section>

        <section>
          <h2 class="mb-2 text-sm font-semibold text-content-primary">{{ t('onboarding.theme') }}</h2>
          <div class="grid grid-cols-2 gap-2">
            <button v-for="option in ([['light', 'onboarding.themeLight'], ['dark', 'onboarding.themeDark'], ['contrast', 'onboarding.themeContrast'], ['system', 'onboarding.themeSystem']] as const)" :key="option[0]" type="button" class="rounded-lg border px-3 py-2 text-sm transition-colors" :class="theme === option[0] ? 'border-accent bg-accent/10 text-content-primary' : 'border-border-subtle text-content-secondary hover:bg-surface-overlay'" @click="selectTheme(option[0])">
              {{ t(option[1]) }}
            </button>
          </div>
        </section>

        <section class="border-t border-border-subtle pt-5">
          <h2 class="text-sm font-semibold text-content-primary">{{ t('onboarding.llm') }}</h2>
          <p class="mb-3 mt-1 text-xs text-content-muted">{{ t('onboarding.llmHint') }}</p>
          <div class="grid gap-3 sm:grid-cols-2">
            <label class="text-xs text-content-secondary">{{ t('onboarding.providerName') }}
              <input v-model="providerName" class="visual-field mt-1 w-full px-3 py-2 text-sm" :placeholder="t('onboarding.providerPlaceholder')" />
            </label>
            <label class="text-xs text-content-secondary">{{ t('onboarding.model') }}
              <input v-model="model" class="visual-field mt-1 w-full px-3 py-2 text-sm" placeholder="gpt-4o" />
            </label>
            <label class="text-xs text-content-secondary sm:col-span-2">{{ t('onboarding.baseUrl') }}
              <input v-model="baseUrl" class="visual-field mt-1 w-full px-3 py-2 text-sm font-mono" placeholder="https://api.openai.com/v1" />
            </label>
            <label class="text-xs text-content-secondary sm:col-span-2">{{ t('onboarding.apiKey') }}
              <input v-model="apiKey" type="password" autocomplete="new-password" class="visual-field mt-1 w-full px-3 py-2 text-sm font-mono" />
            </label>
          </div>
          <p v-if="error" class="mt-3 text-xs text-danger">{{ error }}</p>
        </section>
      </div>

      <footer class="mt-7 flex flex-col-reverse justify-between gap-2 border-t border-border-subtle pt-4 sm:flex-row sm:items-center">
        <button type="button" class="rounded-lg px-3 py-2 text-sm text-content-secondary hover:bg-surface-overlay" :disabled="saving" @click="finish">{{ t('onboarding.skipLlm') }}</button>
        <button type="button" class="rounded-lg bg-accent px-5 py-2 text-sm font-medium text-accent-fg disabled:opacity-50" :disabled="saving" @click="completeSetup">{{ saving ? t('onboarding.saving') : t('onboarding.finish') }}</button>
      </footer>
    </section>
  </div>
</template>
