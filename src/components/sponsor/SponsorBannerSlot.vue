<script setup>
import { computed, ref } from 'vue'
import SponsorBanner from './SponsorBanner.vue'

// A banner slot with several banners shows one per page view, picked at random
// once so live updates of the page do not flip it.
const props = defineProps({
  items: { type: Array, default: () => [] }, // [{ banner, sponsor }]
  layout: { type: String, default: 'wide' },
  placement: { type: String, required: true },
  campaign: { type: String, default: '' },
})

const seed = ref(Math.random())
const current = computed(() => (props.items.length ? props.items[Math.floor(seed.value * props.items.length)] : null))
</script>

<template>
  <SponsorBanner
    v-if="current"
    :key="current.banner.id"
    :banner="current.banner"
    :sponsor="current.sponsor"
    :layout="layout"
    :placement="placement"
    :campaign="campaign"
  />
</template>
