<script setup>
import { computed } from 'vue'
import { theme } from '../../lib/theme'
import { resolveAssetUrl } from '../../lib/sponsorAssets'

// A sponsor's logo at a given height: the dark-background version on the dark
// theme (or when `onDark`), the name in bold when no logo was uploaded.
const props = defineProps({
  sponsor: { type: Object, required: true },
  height: { type: Number, default: 24 },
  onDark: { type: Boolean, default: null },
})

const dark = computed(() => (props.onDark ?? theme.value === 'dark'))
const asset = computed(() => (dark.value && props.sponsor.logoDark) || props.sponsor.logo || null)
const src = computed(() => resolveAssetUrl(asset.value))
const width = computed(() => (asset.value?.width && asset.value?.height
  ? Math.round((props.height * asset.value.width) / asset.value.height)
  : undefined))
</script>

<template>
  <img
    v-if="src"
    class="sponsor-mark"
    :src="src"
    :alt="sponsor.name"
    :height="height"
    :width="width"
    :style="{ height: `${height}px` }"
    loading="lazy"
    decoding="async"
  />
  <span v-else class="sponsor-mark sponsor-mark--text" :style="{ fontSize: `${Math.max(12, height * 0.6)}px` }">{{ sponsor.name }}</span>
</template>

<style scoped>
.sponsor-mark { display: block; flex-shrink: 0; width: auto; max-width: 100%; object-fit: contain; }
.sponsor-mark--text {
  font-family: var(--font-display);
  font-weight: 800;
  letter-spacing: -0.01em;
  line-height: 1;
  white-space: nowrap;
  color: currentColor;
}
</style>
