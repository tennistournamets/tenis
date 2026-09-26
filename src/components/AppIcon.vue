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
  // A padel racket, tilted, with its perforated face: upright it read as a map pin.
  padel: [
    '<ellipse cx="10" cy="10" rx="6" ry="6.8" transform="rotate(-45 10 10)"/>',
    '<path d="m14.4 14.4 5.6 5.6"/>',
    '<path d="m18.4 21.6 3.2-3.2"/>',
    '<circle cx="8" cy="10" r=".6"/>',
    '<circle cx="10" cy="8" r=".6"/>',
    '<circle cx="12" cy="10" r=".6"/>',
    '<circle cx="10" cy="12" r=".6"/>',
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
  code: [
    '<path d="m8 8-4 4 4 4"/>',
    '<path d="m16 8 4 4-4 4"/>',
    '<path d="m13.5 5-3 14"/>',
  ],
  share: [
    '<circle cx="18" cy="5" r="3"/>',
    '<circle cx="6" cy="12" r="3"/>',
    '<circle cx="18" cy="19" r="3"/>',
    '<path d="m8.6 13.5 6.8 4"/>',
    '<path d="m15.4 6.5-6.8 4"/>',
  ],
  link: [
    '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/>',
    '<path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  ],
  qr: [
    '<rect x="3" y="3" width="7" height="7" rx="1"/>',
    '<rect x="14" y="3" width="7" height="7" rx="1"/>',
    '<rect x="3" y="14" width="7" height="7" rx="1"/>',
    '<path d="M14 14h3v3h-3z"/>',
    '<path d="M20 14h1v1h-1z"/>',
    '<path d="M14 20h1v1h-1z"/>',
    '<path d="M18 18h3v3h-3z"/>',
  ],
  play: [
    '<path d="M7 4.5v15l12-7.5z"/>',
  ],
  stop: [
    '<rect x="5" y="5" width="14" height="14" rx="2"/>',
  ],
  download: [
    '<path d="M12 3v12"/>',
    '<path d="m7 10 5 5 5-5"/>',
    '<path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>',
  ],
  check: [
    '<path d="M20 6 9 17l-5-5"/>',
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
