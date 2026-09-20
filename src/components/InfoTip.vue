<script setup>
/**
 * Иконка «i» с подсказкой по hover/фокусу. Заменяет серые абзацы-подсказки под полями.
 * Текст также рендерится скрыто с переданным id, чтобы поля могли ссылаться на него через aria-describedby.
 */
import { useI18n } from 'vue-i18n'

defineProps({
  text: { type: String, required: true },
  id: { type: String, default: undefined },
})
const { t } = useI18n()
</script>

<template>
  <span class="info-tip" :data-tooltip="text">
    <button type="button" class="info-tip__btn" :aria-label="t('actions.hint')" :aria-describedby="id" tabindex="0" @click.prevent>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/></svg>
    </button>
    <span v-if="id" :id="id" class="sr-only">{{ text }}</span>
  </span>
</template>

<style scoped>
.info-tip { position: relative; display: inline-flex; align-items: center; vertical-align: middle; }
.info-tip__btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 24px; height: 24px; padding: 0; border: 0; border-radius: 50%;
  color: var(--muted); background: transparent; cursor: help;
  transition: color .15s, background .15s;
}
.info-tip__btn:hover, .info-tip__btn:focus-visible { color: var(--primary); background: var(--primary-soft); outline: none; }
.info-tip__btn:focus-visible { box-shadow: 0 0 0 3px var(--primary-focus-ring); }
.info-tip:hover::after, .info-tip:focus-within::after {
  content: attr(data-tooltip);
  position: absolute; left: 0; bottom: calc(100% + 6px);
  width: max-content; max-width: min(300px, 80vw);
  padding: 8px 10px; font-size: .78rem; font-weight: 400; line-height: 1.45; text-align: left; white-space: normal;
  color: var(--bg); background: var(--text); border-radius: var(--radius-sm); box-shadow: var(--shadow-lg);
  pointer-events: none; z-index: 60;
}
</style>
