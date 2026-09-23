<script setup>
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { currentPlatform, formatVenuePoint, parseVenuePoint, venueRouteLinks } from '../../lib/venue'

const props = defineProps({
  address: { type: String, default: '' },
  lat: { type: [Number, String, null], default: null },
  lng: { type: [Number, String, null], default: null },
  disabled: Boolean,
})
const emit = defineEmits(['update:address', 'update:lat', 'update:lng'])
const { t } = useI18n()

// What the organizer pasted. The stored point is the parsed result, so an
// unreadable link never silently becomes a wrong location.
const pasted = ref(formatVenuePoint({ lat: props.lat, lng: props.lng }))
watch(() => [props.lat, props.lng], ([lat, lng]) => {
  const stored = formatVenuePoint({ lat, lng })
  if (stored && !parseVenuePoint(pasted.value)) pasted.value = stored
  if (!stored && parseVenuePoint(pasted.value)) pasted.value = ''
})

const point = computed(() => parseVenuePoint(pasted.value))
const pointError = computed(() => Boolean(pasted.value.trim()) && !point.value)
const preview = computed(() => venueRouteLinks(
  { venue_address: props.address, venue_lat: props.lat, venue_lng: props.lng },
  { platform: currentPlatform() },
)[0]?.url || '')

watch(point, found => {
  emit('update:lat', found ? found.lat : null)
  emit('update:lng', found ? found.lng : null)
})

function clearPoint() {
  pasted.value = ''
  emit('update:lat', null)
  emit('update:lng', null)
}
</script>

<template>
  <div class="venue-fields stack stack--sm">
    <div class="form-field">
      <label for="venue-address">{{ t('venue.address') }}</label>
      <input
        id="venue-address"
        class="input"
        type="text"
        maxlength="300"
        autocomplete="street-address"
        :placeholder="t('venue.addressPlaceholder')"
        :disabled="disabled"
        :value="address"
        @input="emit('update:address', $event.target.value)"
      />
    </div>

    <div class="form-field">
      <label for="venue-point">{{ t('venue.point') }}</label>
      <input
        id="venue-point"
        v-model="pasted"
        class="input"
        :class="{ 'input--error': pointError }"
        type="text"
        inputmode="text"
        spellcheck="false"
        :placeholder="t('venue.pointPlaceholder')"
        :disabled="disabled"
        aria-describedby="venue-point-hint"
      />
      <p id="venue-point-hint" class="muted venue-fields__hint">{{ t('venue.pointHint') }}</p>
      <p v-if="pointError" class="error-text" role="alert" style="margin: 0">{{ t('venue.pointInvalid') }}</p>
      <p v-else-if="point" class="venue-fields__point">
        <span class="muted">{{ formatVenuePoint(point) }}</span>
        <button class="btn btn--ghost btn--sm" type="button" :disabled="disabled" @click="clearPoint">
          {{ t('venue.clearPoint') }}
        </button>
      </p>
    </div>

    <p v-if="preview" class="venue-fields__preview">
      <a :href="preview" target="_blank" rel="noopener noreferrer">{{ t('venue.checkOnMap') }}</a>
    </p>
  </div>
</template>

<style scoped>
.venue-fields__hint { margin: 4px 0 0; font-size: 0.8rem; }
.venue-fields__point { display: flex; align-items: center; gap: 10px; margin: 6px 0 0; font-size: .86rem; }
.venue-fields__preview { margin: 0; font-size: .86rem; }
.venue-fields__preview a { color: var(--primary); font-weight: 600; }
</style>
