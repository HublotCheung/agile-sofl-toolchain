<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSidebarViewStore } from '../../stores/sidebarView'
import { useWorkspaceStore } from '../../stores/workspace'
import { editorDocumentKind, type TextMatch } from '../../../shared/textSearch'
import StudioIcon from '../ui/StudioIcon.vue'

const { t } = useI18n()
const sidebar = useSidebarViewStore()
const workspace = useWorkspaceStore()
const findInput = ref<HTMLInputElement | null>(null)
const replaceInput = ref<HTMLInputElement | null>(null)
const selectedKey = ref<string | null>(null)
let timer = 0

const root = computed(() => workspace.activeProject?.rootPath ?? '')
const matchCount = computed(() => sidebar.files.reduce((sum, file) => sum + file.matches.length, 0))
const replaceableCount = computed(() =>
  sidebar.files.reduce((sum, file) => sum + (file.replaceable ? file.matches.length : 0), 0)
)
const allCollapsed = computed(
  () => sidebar.files.length > 0 && sidebar.files.every((file) => sidebar.isCollapsed(file.path))
)

const summary = computed(() => {
  if (!sidebar.query) return ''
  if (sidebar.error) return t('search.regexError')
  if (!root.value) return t('search.noFolder')
  if (!sidebar.searching && matchCount.value === 0) return t('search.noResults')
  return t('search.summary', { matches: matchCount.value, files: sidebar.files.length })
})

function schedule(): void {
  if (!sidebar.query) {
    window.clearTimeout(timer)
    void sidebar.search()
    return
  }
  sidebar.searching = true
  window.clearTimeout(timer)
  timer = window.setTimeout(() => {
    void sidebar.search()
  }, 200)
}

async function focusActive(): Promise<void> {
  await nextTick()
  const el =
    sidebar.focusTarget === 'replace' && sidebar.replaceVisible ? replaceInput.value : findInput.value
  el?.focus()
  el?.select()
}

function matchKey(path: string, match: TextMatch): string {
  return `${path}:${match.start}`
}

function previewParts(match: TextMatch): { before: string; hit: string; after: string } {
  return {
    before: match.preview.slice(0, match.previewStart),
    hit: match.preview.slice(match.previewStart, match.previewEnd),
    after: match.preview.slice(match.previewEnd)
  }
}

function fileLabel(path: string): { name: string; dir: string } {
  if (!root.value) {
    const slash = path.replace(/\\/g, '/').lastIndexOf('/')
    return slash < 0
      ? { name: path, dir: '' }
      : { name: path.slice(slash + 1), dir: path.slice(0, slash) }
  }
  return sidebar.relativeLabel(root.value, path)
}

function toggleReplace(): void {
  sidebar.replaceVisible = !sidebar.replaceVisible
  if (sidebar.replaceVisible) {
    void nextTick(() => {
      replaceInput.value?.focus()
      replaceInput.value?.select()
    })
  }
}

function onWidgetKey(event: KeyboardEvent): void {
  if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
    const key = event.key.toLowerCase()
    if (key === 'c') {
      event.preventDefault()
      sidebar.matchCase = !sidebar.matchCase
      return
    }
    if (key === 'w') {
      event.preventDefault()
      sidebar.wholeWord = !sidebar.wholeWord
      return
    }
    if (key === 'r') {
      event.preventDefault()
      sidebar.useRegex = !sidebar.useRegex
      return
    }
    if (key === 'p' && sidebar.replaceVisible) {
      event.preventDefault()
      sidebar.preserveCase = !sidebar.preserveCase
      return
    }
  }
  if ((event.ctrlKey || event.metaKey) && event.altKey && event.key === 'Enter') {
    event.preventDefault()
    void sidebar.replaceAll()
    return
  }
  if (event.key === 'Enter' && !event.altKey) {
    event.preventDefault()
    window.clearTimeout(timer)
    void sidebar.search()
  }
}

function openMatch(path: string, match: TextMatch): void {
  selectedKey.value = matchKey(path, match)
  const kind = editorDocumentKind(path)
  if (!kind) return
  workspace.revealEditorMatch({
    filePath: path,
    kind,
    start: match.start,
    end: match.end,
    line: match.line,
    column: match.column,
    text: match.text
  })
}

watch(
  () =>
    [
      sidebar.query,
      sidebar.matchCase,
      sidebar.wholeWord,
      sidebar.useRegex,
      sidebar.include,
      sidebar.exclude,
      workspace.activeProjectId
    ] as const,
  () => {
    if (sidebar.view !== 'search') return
    schedule()
  }
)

watch(() => sidebar.focusNonce, () => {
  void focusActive()
})

onMounted(() => {
  void focusActive()
  if (sidebar.query) void sidebar.search()
})
</script>

<template>
  <div data-search-widget class="flex min-h-0 flex-1 flex-col" @keydown="onWidgetKey">
    <div class="flex h-[35px] shrink-0 items-center gap-0.5 px-2">
      <h2 class="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-wide">
        {{ t('search.title') }}
      </h2>
      <button
        type="button"
        class="rounded p-1 text-content-secondary hover:bg-surface-overlay hover:text-content-primary disabled:opacity-40"
        :title="t('search.refresh')"
        :disabled="!sidebar.query || sidebar.searching"
        @click="sidebar.search()"
      >
        <StudioIcon icon="lucide:refresh-cw" :size="14" :class="sidebar.searching ? 'animate-spin' : ''" />
      </button>
      <button
        type="button"
        class="rounded p-1 text-content-secondary hover:bg-surface-overlay hover:text-content-primary disabled:opacity-40"
        :title="allCollapsed ? t('search.expandAll') : t('search.collapseAll')"
        :disabled="!sidebar.files.length"
        @click="allCollapsed ? sidebar.expandAll() : sidebar.collapseAll()"
      >
        <StudioIcon :icon="allCollapsed ? 'lucide:chevrons-up-down' : 'lucide:chevrons-down-up'" :size="14" />
      </button>
      <button
        type="button"
        class="rounded p-1 text-content-secondary hover:bg-surface-overlay hover:text-content-primary"
        :title="t('search.clear')"
        @click="sidebar.clearResults()"
      >
        <StudioIcon icon="lucide:x" :size="14" />
      </button>
    </div>

    <div class="shrink-0 px-2 pb-1">
      <div class="flex items-start gap-0.5">
        <button
          type="button"
          class="mt-1 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded text-content-secondary hover:bg-surface-overlay hover:text-content-primary"
          :title="t('search.toggleReplace')"
          :aria-expanded="sidebar.replaceVisible"
          @click="toggleReplace"
        >
          <StudioIcon :icon="sidebar.replaceVisible ? 'lucide:chevron-down' : 'lucide:chevron-right'" :size="14" />
        </button>
        <div class="min-w-0 flex-1">
          <div
            class="flex h-[26px] items-center rounded-sm border bg-surface-base"
            :class="sidebar.error ? 'border-semantic-error' : 'border-border-subtle focus-within:border-accent'"
          >
            <input
              ref="findInput"
              v-model="sidebar.query"
              class="min-w-0 flex-1 bg-transparent px-1.5 text-[13px] text-content-primary outline-none placeholder:text-content-muted"
              :placeholder="t('search.placeholder')"
              spellcheck="false"
              :aria-label="t('search.placeholder')"
            />
            <div class="flex shrink-0 items-center pr-0.5">
              <button
                type="button"
                class="find-toggle"
                :class="sidebar.matchCase ? 'find-toggle-on' : ''"
                :title="t('search.matchCase')"
                :aria-pressed="sidebar.matchCase"
                @click="sidebar.matchCase = !sidebar.matchCase"
              >Aa</button>
              <button
                type="button"
                class="find-toggle"
                :class="sidebar.wholeWord ? 'find-toggle-on' : ''"
                :title="t('search.wholeWord')"
                :aria-pressed="sidebar.wholeWord"
                @click="sidebar.wholeWord = !sidebar.wholeWord"
              ><span class="whole-word">ab</span></button>
              <button
                type="button"
                class="find-toggle font-mono"
                :class="sidebar.useRegex ? 'find-toggle-on' : ''"
                :title="t('search.regex')"
                :aria-pressed="sidebar.useRegex"
                @click="sidebar.useRegex = !sidebar.useRegex"
              >.*</button>
            </div>
          </div>
          <div v-if="sidebar.replaceVisible" class="mt-1 flex h-[26px] items-center gap-0.5">
            <div class="flex h-full min-w-0 flex-1 items-center rounded-sm border border-border-subtle bg-surface-base focus-within:border-accent">
              <input
                ref="replaceInput"
                v-model="sidebar.replaceText"
                class="min-w-0 flex-1 bg-transparent px-1.5 text-[13px] text-content-primary outline-none placeholder:text-content-muted"
                :placeholder="t('search.replacePlaceholder')"
                spellcheck="false"
                :aria-label="t('search.replacePlaceholder')"
              />
              <button
                type="button"
                class="find-toggle mr-0.5"
                :class="sidebar.preserveCase ? 'find-toggle-on' : ''"
                :title="t('search.preserveCase')"
                :aria-pressed="sidebar.preserveCase"
                @click="sidebar.preserveCase = !sidebar.preserveCase"
              >AB</button>
            </div>
            <button
              type="button"
              class="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-sm text-content-secondary hover:bg-surface-overlay hover:text-content-primary disabled:opacity-40"
              :title="t('search.replaceAllShortcut')"
              :disabled="!replaceableCount || sidebar.replacing || !!sidebar.error"
              @click="sidebar.replaceAll()"
            >
              <StudioIcon icon="lucide:replace-all" :size="15" />
            </button>
          </div>
        </div>
        <button
          type="button"
          class="mt-0.5 flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded text-content-secondary hover:bg-surface-overlay"
          :class="sidebar.detailsOpen ? 'bg-surface-overlay text-content-primary' : ''"
          :title="t('search.toggleDetails')"
          :aria-expanded="sidebar.detailsOpen"
          @click="sidebar.detailsOpen = !sidebar.detailsOpen"
        >
          <StudioIcon icon="lucide:ellipsis" :size="14" />
        </button>
      </div>
      <div v-if="sidebar.detailsOpen" class="mt-1 space-y-1 pl-[20px] pr-[24px]">
        <input
          v-model="sidebar.include"
          class="h-[26px] w-full rounded-sm border border-border-subtle bg-surface-base px-1.5 text-[13px] outline-none focus:border-accent"
          :placeholder="t('search.include')"
          spellcheck="false"
          :aria-label="t('search.include')"
        />
        <input
          v-model="sidebar.exclude"
          class="h-[26px] w-full rounded-sm border border-border-subtle bg-surface-base px-1.5 text-[13px] outline-none focus:border-accent"
          :placeholder="t('search.exclude')"
          spellcheck="false"
          :aria-label="t('search.exclude')"
        />
      </div>
      <p v-if="sidebar.error" class="mt-1 pl-[20px] text-[11px] text-semantic-error">{{ sidebar.error }}</p>
    </div>

    <div v-if="summary" class="shrink-0 px-3 py-1 text-[12px] text-content-secondary">
      <p>{{ summary }}</p>
      <p v-if="sidebar.truncated" class="text-content-muted">{{ t('search.truncated', { count: matchCount }) }}</p>
    </div>

    <div class="studio-scroll min-h-0 flex-1 overflow-auto pb-2">
      <section v-for="file in sidebar.files" :key="file.path" class="group/file">
        <div
          class="sticky top-0 z-[1] flex h-[22px] items-center gap-1 bg-surface-raised pr-1 hover:bg-surface-overlay"
          :title="file.replaceable ? file.path : t('search.readonly')"
        >
          <button
            type="button"
            class="flex h-full min-w-0 flex-1 items-center gap-1 pl-1 text-left"
            @click="sidebar.toggleCollapsed(file.path)"
          >
            <StudioIcon
              :icon="sidebar.isCollapsed(file.path) ? 'lucide:chevron-right' : 'lucide:chevron-down'"
              :size="14"
              class="shrink-0 text-content-muted"
            />
            <span class="truncate text-[13px] text-content-primary">{{ fileLabel(file.path).name }}</span>
            <span v-if="fileLabel(file.path).dir" class="min-w-0 truncate text-[12px] text-content-muted">
              {{ fileLabel(file.path).dir }}
            </span>
          </button>
          <span
            v-if="!file.replaceable"
            class="shrink-0 px-0.5 text-content-muted"
            :title="t('search.readonly')"
          >
            <StudioIcon icon="lucide:lock" :size="12" />
          </span>
          <span class="shrink-0 rounded-full bg-surface-overlay px-1.5 text-[11px] text-content-secondary">
            {{ file.matches.length }}
          </span>
          <span
            class="flex shrink-0 items-center opacity-0 group-hover/file:opacity-100 focus-within:opacity-100"
          >
            <button
              v-if="file.replaceable && sidebar.replaceVisible"
              type="button"
              class="rounded p-0.5 text-content-secondary hover:bg-surface-base hover:text-content-primary"
              :title="t('search.replaceInFile')"
              @click="sidebar.replaceAll(file.path)"
            >
              <StudioIcon icon="lucide:replace-all" :size="13" />
            </button>
            <button
              type="button"
              class="rounded p-0.5 text-content-secondary hover:bg-surface-base hover:text-content-primary"
              :title="t('search.reveal')"
              @click="window.studio?.revealInFolder(file.path)"
            >
              <StudioIcon icon="lucide:folder-open" :size="13" />
            </button>
            <button
              type="button"
              class="rounded p-0.5 text-content-secondary hover:bg-surface-base hover:text-content-primary"
              :title="t('search.dismiss')"
              @click="sidebar.dismissFile(file.path)"
            >
              <StudioIcon icon="lucide:x" :size="13" />
            </button>
          </span>
        </div>
        <div v-if="!sidebar.isCollapsed(file.path)">
          <div
            v-for="match in file.matches"
            :key="matchKey(file.path, match)"
            class="group/match flex h-[22px] cursor-pointer items-center pr-1 hover:bg-surface-overlay/80"
            :class="selectedKey === matchKey(file.path, match) ? 'bg-accent/15' : ''"
            @click="openMatch(file.path, match)"
          >
            <span class="w-12 shrink-0 pr-2 text-right text-[12px] text-content-muted">{{ match.line }}</span>
            <span class="min-w-0 flex-1 truncate whitespace-pre font-mono text-[12px] text-content-secondary">
              <span>{{ previewParts(match).before }}</span><mark class="find-match">{{ previewParts(match).hit }}</mark><span>{{ previewParts(match).after }}</span>
            </span>
            <span class="flex shrink-0 opacity-0 group-hover/match:opacity-100 focus-within:opacity-100">
              <button
                v-if="file.replaceable && sidebar.replaceVisible"
                type="button"
                class="rounded p-0.5 text-content-secondary hover:bg-surface-base hover:text-content-primary"
                :title="t('search.replaceMatch')"
                @click.stop="sidebar.replaceMatch(file.path, match)"
              >
                <StudioIcon icon="lucide:replace" :size="13" />
              </button>
              <button
                type="button"
                class="rounded p-0.5 text-content-secondary hover:bg-surface-base hover:text-content-primary"
                :title="t('search.dismiss')"
                @click.stop="sidebar.dismissMatch(file.path, match.start)"
              >
                <StudioIcon icon="lucide:x" :size="13" />
              </button>
            </span>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.find-toggle {
  display: inline-flex;
  height: 20px;
  min-width: 20px;
  align-items: center;
  justify-content: center;
  border-radius: 3px;
  padding: 0 2px;
  font-size: 11px;
  line-height: 1;
  color: var(--content-secondary, inherit);
}
.find-toggle:hover {
  background: var(--surface-overlay);
}
.find-toggle-on {
  background: var(--accent);
  color: var(--accent-fg);
}
.whole-word {
  border-bottom: 1px solid currentColor;
  line-height: 1;
}
.find-match {
  border-radius: 2px;
  background: rgba(234, 92, 0, 0.33);
  color: inherit;
}
</style>
