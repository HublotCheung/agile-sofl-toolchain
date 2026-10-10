<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { dualLineProgress } from '../../../lib/atomicityTree'
import { initChart, type StudioChart, type StudioChartOption } from '../../../lib/echarts'
import { emptyRefinementState, type RefinementStateDto } from '../../../lib/refinementTypes'

const props = defineProps<{
  state: RefinementStateDto | null
}>()

const { t, locale } = useI18n()
const host = ref<HTMLElement | null>(null)
const model = computed(() => props.state ?? emptyRefinementState())
const progress = computed(() => dualLineProgress(model.value))

let chart: StudioChart | null = null
let resizeObs: ResizeObserver | null = null
let themeObs: MutationObserver | null = null

function css(name: string, fallback: string): string {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return raw || fallback
}

function theme() {
  return {
    accent: css('--accent', '#00668b'),
    warning: css('--semantic-warning', '#d97706'),
    error: css('--semantic-error', '#e11d48'),
    text: css('--text-primary', '#15202b'),
    muted: css('--text-muted', '#7a8490'),
    secondary: css('--text-secondary', '#4a5560'),
    raised: css('--surface-raised', '#ffffff'),
    overlay: css('--surface-overlay', '#f3f5f7'),
    border: css('--border-subtle', '#d8dee6')
  }
}

function buildOption(): StudioChartOption {
  const c = theme()
  const p = progress.value
  const overallPct = Math.round(p.overall * 100)
  const processPct = Math.round(p.processRate * 100)
  const dataPct = Math.round(p.dataRate * 100)
  const grainPct = Math.round(p.grainRate * 100)
  const remain = p.remaining
  const indicators = [
    { name: t('visual.refine.radar.empty'), max: Math.max(remain.empty, 1) },
    { name: t('visual.refine.radar.stub'), max: Math.max(remain.stub, 1) },
    { name: t('visual.refine.radar.informal'), max: Math.max(remain.informal, 1) },
    { name: t('visual.refine.radar.coverage'), max: Math.max(remain.coverage, 1) },
    { name: t('visual.refine.radar.cond'), max: Math.max(remain.cond, 1) },
    { name: t('visual.refine.radar.boundary'), max: Math.max(remain.boundary, 1) },
    { name: t('visual.refine.radar.undeclared'), max: Math.max(remain.undeclared, 1) },
    { name: t('visual.refine.radar.data'), max: Math.max(remain.data, 1) },
    { name: t('visual.refine.radar.grain'), max: Math.max(remain.grain, 1) }
  ]
  return {
    backgroundColor: 'transparent',
    textStyle: { color: c.text, fontFamily: 'inherit' },
    tooltip: {
      trigger: 'item',
      backgroundColor: c.raised,
      borderColor: c.border,
      textStyle: { color: c.text, fontSize: 11 }
    },
    title: {
      text: t('visual.refine.chartTitle'),
      subtext: t('visual.refine.chartHint', {
        atomic: p.atomicLeaves,
        expected: p.expectedLeaves,
        empty: p.emptyModules,
        stub: p.stubProcesses
      }),
      left: 8,
      top: 4,
      textStyle: { color: c.text, fontSize: 13, fontWeight: 600 },
      subtextStyle: { color: c.muted, fontSize: 10, lineHeight: 16 }
    },
    grid: { left: '4%', right: '52%', top: 118, bottom: 12, containLabel: true },
    xAxis: {
      type: 'value',
      max: 100,
      axisLabel: { color: c.muted, formatter: '{value}%', fontSize: 10 },
      splitLine: { lineStyle: { color: c.border, opacity: 0.6 } },
      axisLine: { show: false },
      axisTick: { show: false }
    },
    yAxis: {
      type: 'category',
      data: [t('visual.refine.dataLine'), t('visual.refine.grainLine'), t('visual.refine.processLine')],
      axisLabel: { color: c.secondary, fontSize: 11 },
      axisLine: { show: false },
      axisTick: { show: false }
    },
    radar: {
      center: ['76%', '58%'],
      radius: '42%',
      indicator: indicators,
      axisName: { color: c.secondary, fontSize: 10 },
      splitArea: { areaStyle: { color: [c.overlay, 'transparent'] } },
      splitLine: { lineStyle: { color: c.border } },
      axisLine: { lineStyle: { color: c.border } }
    },
    series: [
      {
        type: 'gauge',
        center: ['24%', '38%'],
        radius: '48%',
        startAngle: 210,
        endAngle: -30,
        min: 0,
        max: 100,
        progress: { show: true, width: 12, itemStyle: { color: c.accent } },
        axisLine: { lineStyle: { width: 12, color: [[1, c.border]] } },
        pointer: { show: false },
        axisTick: { show: false },
        splitLine: { show: false },
        axisLabel: { show: false },
        anchor: { show: false },
        title: { offsetCenter: [0, '78%'], color: c.muted, fontSize: 11 },
        detail: {
          valueAnimation: true,
          fontSize: 26,
          fontWeight: 650,
          color: c.text,
          offsetCenter: [0, '8%'],
          formatter: '{value}%'
        },
        data: [{ value: overallPct, name: t('visual.refine.overall') }]
      },
      {
        type: 'bar',
        data: [
          { value: dataPct, itemStyle: { color: c.warning, borderRadius: [0, 4, 4, 0] } },
          { value: grainPct, itemStyle: { color: c.error, borderRadius: [0, 4, 4, 0] } },
          { value: processPct, itemStyle: { color: c.accent, borderRadius: [0, 4, 4, 0] } }
        ],
        barWidth: 10,
        label: { show: true, position: 'right', color: c.secondary, fontSize: 10, formatter: '{c}%' }
      },
      {
        type: 'radar',
        symbol: 'circle',
        symbolSize: 5,
        lineStyle: { color: c.error, width: 2 },
        itemStyle: { color: c.error },
        areaStyle: { color: c.error, opacity: 0.18 },
        data: [
          {
            value: [
              remain.empty,
              remain.stub,
              remain.informal,
              remain.coverage,
              remain.cond,
              remain.boundary,
              remain.undeclared,
              remain.data,
              remain.grain
            ],
            name: t('visual.refine.remaining')
          }
        ]
      }
    ]
  }
}

function render(): void {
  if (!chart) return
  chart.setOption(buildOption(), true)
}

onMounted(() => {
  if (!host.value) return
  chart = initChart(host.value)
  render()
  resizeObs = new ResizeObserver(() => chart?.resize())
  resizeObs.observe(host.value)
  themeObs = new MutationObserver(() => render())
  themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
})

onUnmounted(() => {
  resizeObs?.disconnect()
  themeObs?.disconnect()
  chart?.dispose()
  chart = null
})

watch([progress, locale], () => render(), { deep: true })
</script>

<template>
  <div
    ref="host"
    class="h-[188px] w-full shrink-0"
    role="img"
    :aria-label="t('visual.refine.chartTitle')"
  />
</template>
