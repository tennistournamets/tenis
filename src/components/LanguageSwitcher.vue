<script setup>
import { nextTick, onMounted, onUnmounted, ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'

const { locale } = useI18n()
const open = ref(false)
const root = ref(null)
const trigger = ref(null)
const menuId = useId()

const locales = [
  { code: 'ru', label: 'RU', name: 'Русский' },
  { code: 'en', label: 'EN', name: 'English' },
  { code: 'lt', label: 'LT', name: 'Lietuvių' },
]

const currentLocale = () => locales.find((l) => l.code === locale.value) || locales[0]

function setLocale(code) {
  locale.value = code
  open.value = false
  trigger.value?.focus()
  try {
    localStorage.setItem('champ_locale', code)
  } catch {
    /* ignore */
  }
}

async function show(index = locales.findIndex(item => item.code === locale.value)) {
  open.value = true
  await nextTick()
  root.value?.querySelectorAll('[role="option"]')[Math.max(0, index)]?.focus()
}

function toggle() {
  if (open.value) close()
  else show()
}

function close() {
  open.value = false
}

function onKeydown(event) {
  if (event.key === 'Tab' && open.value) {
    close()
    trigger.value?.focus()
    return
  }
  if (event.key === 'Escape' && open.value) {
    event.preventDefault()
    event.stopPropagation()
    close()
    trigger.value?.focus()
    return
  }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  if (!open.value) { show(); return }
  const options = [...root.value.querySelectorAll('[role="option"]')]
  const current = options.indexOf(document.activeElement)
  const index = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1
    : (current + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length
  options[index]?.focus()
}

function onFocusout(event) {
  if (!root.value?.contains(event.relatedTarget)) close()
}
function onPointerdown(event) {
  if (!root.value?.contains(event.target)) close()
}
onMounted(() => document.addEventListener('pointerdown', onPointerdown))
onUnmounted(() => document.removeEventListener('pointerdown', onPointerdown))
</script>

<template>
  <div ref="root" class="lang-dropdown" @click.stop @keydown="onKeydown" @focusout="onFocusout">
    <button
      ref="trigger"
      class="lang-dropdown__trigger"
      type="button"
      :aria-expanded="open"
      aria-haspopup="listbox"
      :aria-controls="open ? menuId : undefined"
      aria-label="Language / Язык / Kalba"
      @click="toggle"
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6.5"/><path d="M1.5 8h13"/><ellipse cx="8" cy="8" rx="3" ry="6.5"/></svg>
      <span>{{ currentLocale().label }}</span>
      <svg class="lang-dropdown__chevron" :class="{ 'lang-dropdown__chevron--open': open }" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5l3 3 3-3"/></svg>
    </button>
    <div v-if="open" :id="menuId" class="lang-dropdown__menu" role="listbox" aria-label="Language / Язык / Kalba">
      <button
        v-for="item in locales"
        :key="item.code"
        type="button"
        class="lang-dropdown__item"
        :class="{ 'lang-dropdown__item--active': locale === item.code }"
        role="option"
        tabindex="-1"
        :aria-selected="locale === item.code"
        @click="setLocale(item.code)"
      >
        <span class="lang-dropdown__item-label">{{ item.label }}</span>
        <span class="lang-dropdown__item-name">{{ item.name }}</span>
      </button>
    </div>
  </div>
</template>
