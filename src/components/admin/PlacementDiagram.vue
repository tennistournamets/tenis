<script setup>
// A tiny page mock-up with the place highlighted, so the organizer sees at a
// glance where on the page (or outside it) the sponsor will appear.
defineProps({
  place: { type: String, required: true },
})
</script>

<template>
  <svg class="placement-diagram" viewBox="0 0 120 84" aria-hidden="true">
    <!-- Live score: a window over the page. -->
    <template v-if="place === 'live'">
      <rect class="pd-frame" x="1" y="1" width="118" height="82" rx="6" />
      <rect class="pd-block" x="8" y="10" width="104" height="12" rx="2" />
      <rect class="pd-block" x="8" y="26" width="104" height="50" rx="2" />
      <rect class="pd-shade" x="1" y="1" width="118" height="82" rx="6" />
      <rect class="pd-card" x="30" y="14" width="60" height="58" rx="4" />
      <rect class="pd-line" x="36" y="22" width="48" height="16" rx="2" />
      <rect class="pd-line" x="36" y="42" width="48" height="5" rx="1" />
      <rect class="pd-line" x="36" y="50" width="48" height="5" rx="1" />
      <rect class="pd-hot" x="44" y="61" width="32" height="5" rx="2" />
    </template>

    <!-- Club-site widget: someone else's page with the tournament inside. -->
    <template v-else-if="place === 'embed'">
      <rect class="pd-frame" x="1" y="1" width="118" height="82" rx="6" />
      <rect class="pd-block" x="8" y="8" width="40" height="6" rx="2" />
      <rect class="pd-card pd-card--dashed" x="14" y="20" width="92" height="56" rx="3" />
      <rect class="pd-line" x="20" y="27" width="80" height="8" rx="2" />
      <rect class="pd-line" x="20" y="39" width="80" height="22" rx="2" />
      <rect class="pd-hot" x="20" y="66" width="30" height="5" rx="2" />
    </template>

    <!-- A4 poster. -->
    <template v-else-if="place === 'poster'">
      <rect class="pd-frame" x="34" y="1" width="52" height="82" rx="3" />
      <rect class="pd-line" x="40" y="8" width="16" height="5" rx="1" />
      <rect class="pd-hot" x="62" y="7" width="18" height="7" rx="2" />
      <rect class="pd-line" x="40" y="20" width="40" height="7" rx="1" />
      <rect class="pd-block" x="46" y="34" width="28" height="28" rx="2" />
      <rect class="pd-line" x="40" y="68" width="40" height="4" rx="1" />
    </template>

    <!-- The public tournament page. -->
    <template v-else>
      <rect class="pd-frame" x="1" y="1" width="118" height="82" rx="6" />
      <rect class="pd-bar" x="1" y="1" width="118" height="7" rx="6" />
      <rect class="pd-block" :class="{ 'pd-block--win': place === 'champion' }" x="7" y="12" width="106" height="13" rx="2" />
      <rect class="pd-line" x="11" y="15" width="34" height="3" rx="1" />
      <rect v-if="place === 'hero'" class="pd-hot" x="11" y="20" width="26" height="3.5" rx="1" />
      <rect v-if="place === 'champion'" class="pd-hot" x="80" y="16" width="28" height="5" rx="1.5" />

      <rect :class="place === 'top' ? 'pd-hot' : 'pd-ghost'" x="7" y="28" width="106" height="9" rx="2" />

      <template v-if="place === 'registration'">
        <rect class="pd-block" x="7" y="40" width="66" height="32" rx="2" />
        <rect class="pd-line" x="11" y="45" width="58" height="4" rx="1" />
        <rect class="pd-line" x="11" y="52" width="58" height="4" rx="1" />
        <rect class="pd-line" x="11" y="59" width="58" height="4" rx="1" />
        <rect class="pd-block" x="77" y="40" width="36" height="12" rx="2" />
        <rect class="pd-hot" x="77" y="55" width="36" height="17" rx="2" />
      </template>
      <template v-else-if="place === 'standings'">
        <rect class="pd-block" x="7" y="40" width="106" height="32" rx="2" />
        <rect class="pd-line" x="11" y="44" width="30" height="4" rx="1" />
        <rect class="pd-hot" x="80" y="44" width="29" height="4" rx="1" />
        <rect class="pd-line" x="11" y="52" width="98" height="3" rx="1" />
        <rect class="pd-line" x="11" y="58" width="98" height="3" rx="1" />
        <rect class="pd-line" x="11" y="64" width="98" height="3" rx="1" />
      </template>
      <template v-else>
        <rect class="pd-block" x="7" y="40" width="106" height="32" rx="2" />
        <!-- bracket -->
        <rect class="pd-line" x="13" y="44" width="18" height="6" rx="1" />
        <rect class="pd-line" x="13" y="60" width="18" height="6" rx="1" />
        <rect class="pd-line" x="89" y="44" width="18" height="6" rx="1" />
        <rect class="pd-line" x="89" y="60" width="18" height="6" rx="1" />
        <rect class="pd-line" x="51" y="52" width="18" height="6" rx="1" />
        <path class="pd-link" d="M31 47h8v16h-8M39 55h12M89 47h-8v16h8M81 55h-12" />
        <rect v-if="place === 'bracket'" class="pd-hot" x="50" y="61" width="20" height="4" rx="1" />
      </template>

      <rect :class="place === 'bottom' ? 'pd-hot' : 'pd-ghost'" x="7" y="75" width="72" height="5" rx="1.5" />
      <g :class="place === 'partners' ? 'pd-hot' : 'pd-ghost'">
        <rect x="83" y="75" width="8" height="5" rx="1" />
        <rect x="94" y="75" width="8" height="5" rx="1" />
        <rect x="105" y="75" width="8" height="5" rx="1" />
      </g>
    </template>
  </svg>
</template>

<style scoped>
.placement-diagram { display: block; width: 100%; height: auto; }
.pd-frame { fill: var(--surface); stroke: var(--border-strong); stroke-width: 1.2; }
.pd-bar { fill: var(--surface-2); }
.pd-block { fill: var(--surface-2); stroke: var(--border); stroke-width: 0.8; }
.pd-block--win { fill: var(--success-bg); stroke: var(--success-border); }
.pd-line { fill: var(--border-strong); opacity: 0.55; }
.pd-link { fill: none; stroke: var(--border-strong); stroke-width: 1; opacity: 0.7; }
.pd-ghost { fill: var(--border); opacity: 0.5; }
.pd-shade { fill: #000; opacity: 0.35; }
.pd-card { fill: var(--surface); stroke: var(--border-strong); stroke-width: 1; }
.pd-card--dashed { stroke-dasharray: 3 2; }
.pd-hot { fill: var(--primary); }
g.pd-hot rect, g.pd-ghost rect { fill: inherit; }
</style>
