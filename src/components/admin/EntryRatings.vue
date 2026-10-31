<script setup>
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { formatRatingValue } from '../../lib/playerRatings'

// The ratings of an entry's players under its name in the organizer's lists.
// A pair shows each player's ratings after their name; a value the organizer
// changed shows the player's one struck through.
const props = defineProps({
  ratings: { type: Object, default: null },
  members: { type: Array, default: () => [] },
})
const { t } = useI18n()

const lines = computed(() => {
  if (!props.ratings) return []
  const pair = Object.keys(props.ratings).length > 1 || props.members.length > 1
  return Object.entries(props.ratings)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([order, list]) => ({
      order,
      name: pair ? props.members.find(m => String(m.member_order) === order)?.member_name || '' : '',
      items: list.map(r => ({
        type: r.type,
        label: t(`playerRating.short.${r.type}`),
        value: formatRatingValue(r.type, r.value),
        replaced: r.organizer != null && r.player != null && r.organizer !== r.player ? formatRatingValue(r.type, r.player) : '',
        byOrganizer: r.organizer != null,
      })),
    }))
})
</script>

<template>
  <span v-if="lines.length" class="entry-ratings">
    <span v-for="line in lines" :key="line.order" class="entry-ratings__line">
      <span v-if="line.name" class="entry-ratings__name">{{ line.name }}:</span>
      <span
        v-for="item in line.items"
        :key="item.type"
        class="entry-ratings__item"
        :title="t(item.byOrganizer ? 'playerRating.byOrganizer' : 'playerRating.adminTitle')"
      >
        {{ item.label }}
        <s v-if="item.replaced" class="entry-ratings__old">{{ item.replaced }}</s>
        <span :class="{ 'entry-ratings__org': item.byOrganizer }">{{ item.value }}</span>
      </span>
    </span>
  </span>
</template>

<style scoped>
.entry-ratings {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 12px;
  margin-top: 2px;
  font-size: 0.8125rem;
  font-weight: 500;
  color: var(--text);
  font-variant-numeric: tabular-nums;
}
.entry-ratings__line { display: inline-flex; flex-wrap: wrap; gap: 2px 8px; }
.entry-ratings__name { color: var(--muted); font-weight: 400; }
.entry-ratings__item { display: inline-flex; gap: 4px; }
.entry-ratings__old { color: var(--muted); font-weight: 400; }
.entry-ratings__org { color: var(--primary); }
</style>
