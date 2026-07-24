<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue'

const props = defineProps({
  align: { type: String, default: 'right' }, // 'left' | 'right'
  ariaLabel: { type: String, default: 'Actions' },
})

const open = ref(false)
const root = ref(null)

function toggle() {
  open.value = !open.value
}

function close() {
  open.value = false
}

function onDocMouseDown(e) {
  if (!open.value) return
  if (root.value && !root.value.contains(e.target)) {
    close()
  }
}

function onKeydown(e) {
  if (e.key === 'Escape' && open.value) {
    close()
  }
}

onMounted(() => {
  document.addEventListener('mousedown', onDocMouseDown)
  document.addEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocMouseDown)
  document.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <div ref="root" class="kebab">
    <button
      type="button"
      class="kebab__trigger"
      :aria-label="ariaLabel"
      :aria-expanded="open"
      aria-haspopup="menu"
      @click.stop="toggle"
    >
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="3" r="1.5" />
        <circle cx="8" cy="8" r="1.5" />
        <circle cx="8" cy="13" r="1.5" />
      </svg>
    </button>
    <div
      v-if="open"
      class="kebab__pop"
      :class="{ 'kebab__pop--left': align === 'left' }"
      role="menu"
      @click="close"
    >
      <slot />
    </div>
  </div>
</template>

<style scoped>
.kebab {
  position: relative;
  display: inline-block;
}
.kebab__trigger {
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  width: 32px;
  height: 32px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  color: var(--muted);
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}
.kebab__trigger:hover {
  color: var(--text);
  background: var(--surface-hover);
}
.kebab__trigger[aria-expanded="true"] {
  color: var(--text);
  background: var(--disabled-bg);
  border-color: var(--border);
}
.kebab__pop {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  min-width: 180px;
  background: var(--surface, #1a1a1a);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-lg, 0 8px 24px rgba(0, 0, 0, 0.4));
  padding: 4px;
  z-index: 50;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.kebab__pop--left {
  right: auto;
  left: 0;
}
.kebab__pop :slotted(button) {
  appearance: none;
  background: transparent;
  border: none;
  color: var(--text);
  text-align: left;
  padding: 8px 12px;
  border-radius: 4px;
  font: inherit;
  cursor: pointer;
  white-space: nowrap;
}
.kebab__pop :slotted(button:hover) {
  background: var(--surface-hover);
}
.kebab__pop :slotted(button.kebab__danger) {
  color: var(--danger, #f87171);
}
.kebab__pop :slotted(button.kebab__danger:hover) {
  background: var(--danger-bg);
}
</style>
