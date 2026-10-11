import { initMonacoNlsFromStudioLocale } from './monaco/nls'
import { i18n, isStudioLocale, type Locale } from './i18n'
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import './styles/main.css'
import { registerStudioIcons } from './icons/registerStudioIcons'

const rawLocale = localStorage.getItem('studio-locale')
const savedLocale: Locale = rawLocale && isStudioLocale(rawLocale) ? rawLocale : 'zh-CN'
initMonacoNlsFromStudioLocale(savedLocale)

registerStudioIcons()

createApp(App).use(createPinia()).use(i18n).mount('#app')
