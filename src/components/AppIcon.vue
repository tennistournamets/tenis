<script setup>
/**
 * Единственный источник иконок для админки.
 * Штриховые SVG 24×24, currentColor — наследуют цвет и тему,
 * в отличие от эмодзи, которые растрируются шрифтом ОС.
 */
const props = defineProps({
  name: { type: String, required: true },
  size: { type: [Number, String], default: 20 },
})

// Каждое значение — набор <path>/<circle>, рисуемых обводкой.
const PATHS = {
  tennis: [
    '<circle cx="12" cy="12" r="9"/>',
    '<path d="M7.2 4.4c2.3 2.2 3.5 4.7 3.5 7.6s-1.2 5.4-3.5 7.6"/>',
    '<path d="M16.8 4.4c-2.3 2.2-3.5 4.7-3.5 7.6s1.2 5.4 3.5 7.6"/>',
  ],
  padel: [
    '<ellipse cx="12" cy="9.5" rx="6.5" ry="7"/>',
    '<circle cx="12" cy="9.5" r="2.2"/>',
    '<path d="M12 16.5V21"/>',
    '<path d="M9.5 21.5h5"/>',
  ],
  football: [
    '<circle cx="12" cy="12" r="9"/>',
    '<path d="m12 7 3.2 2.3-1.2 3.7h-4L8.8 9.3z"/>',
    '<path d="M12 3v4"/>',
    '<path d="m4.6 9.7 4.2 3"/>',
    '<path d="m19.4 9.7-4.2 3"/>',
    '<path d="M7.6 19.6 10 13"/>',
    '<path d="M16.4 19.6 14 13"/>',
  ],
  trophy: [
    '<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/>',
    '<path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/>',
    '<path d="M4 22h16"/>',
    '<path d="M10 14.7V17c0 .6-.5 1-1 1.2C7.9 18.8 7 20.2 7 22"/>',
    '<path d="M14 14.7V17c0 .6.5 1 1 1.2 1.1.6 2 2 2 3.8"/>',
    '<path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/>',
  ],
  // Форматы турниров
  single_elimination: [
    '<path d="M3 5h4a2 2 0 0 1 2 2v10a2 2 0 0 0 2 2h3"/>',
    '<path d="M3 19h4"/>',
    '<path d="M14 12h3"/>',
    '<rect x="17" y="9.5" width="4" height="5" rx="1"/>',
  ],
  round_robin: [
    '<path d="M20.5 12a8.5 8.5 0 0 1-14.6 5.9"/>',
    '<path d="M3.5 12a8.5 8.5 0 0 1 14.6-5.9"/>',
    '<path d="M18.5 3v3.5H15"/>',
    '<path d="M5.5 21v-3.5H9"/>',
  ],
  groups_playoff: [
    '<rect x="3" y="4" width="7" height="7" rx="1.5"/>',
    '<rect x="3" y="13" width="7" height="7" rx="1.5"/>',
    '<path d="M10 7.5h3a2 2 0 0 1 2 2v5a2 2 0 0 0 2 2h1"/>',
    '<path d="M10 16.5h2"/>',
  ],
  double_elimination: [
    '<path d="M3 6h3a2 2 0 0 1 2 2v3"/>',
    '<path d="M3 18h3a2 2 0 0 0 2-2v-3"/>',
    '<path d="M8 12h6"/>',
    '<circle cx="18" cy="12" r="3"/>',
  ],
}

const paths = () => (PATHS[props.name] || PATHS.trophy).join('')
</script>

<template>
  <svg
    class="app-icon"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.75"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
    v-html="paths()"
  />
</template>

<style scoped>
.app-icon {
  display: block;
  flex-shrink: 0;
}
</style>
