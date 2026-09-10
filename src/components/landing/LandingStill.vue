<script setup>
defineProps({ kind: { type: String, default: 'bracket' } })
</script>

<template>
  <svg class="landing-still" viewBox="0 0 400 280" fill="none" aria-hidden="true">
    <template v-if="kind === 'cup'">
      <ellipse cx="200" cy="239" rx="138" ry="16" fill="currentColor" opacity=".07" />
      <path d="M80 198h80v40H80zM160 173h80v65h-80zM240 210h80v28h-80z" fill="currentColor" opacity=".12" />
      <path d="M150 56h100v39c0 37-22 60-50 60s-50-23-50-60V56Z" fill="var(--lime)" stroke="currentColor" stroke-width="2" />
      <path d="M151 69h-29v22c0 26 17 37 40 37M249 69h29v22c0 26-17 37-40 37M200 155v25m-28 8h56" stroke="currentColor" stroke-width="7" stroke-linecap="round" />
      <path d="m200 76 7 14 16 2-12 11 3 16-14-8-14 8 3-16-12-11 16-2 7-14Z" fill="currentColor" />
      <path d="m105 43 6 10m180 85 9-5M93 147l-7 9m185-111 6-11" stroke="currentColor" stroke-width="3" opacity=".5" />
      <text x="120" y="223" text-anchor="middle" fill="currentColor" font-size="16">2</text>
      <text x="200" y="219" text-anchor="middle" fill="currentColor" font-size="22">1</text>
      <text x="280" y="232" text-anchor="middle" fill="currentColor" font-size="16">3</text>
    </template>
    <template v-else>
      <path d="M125 52h32v60h-32m32-30h37M125 172h32v60h-32m32-30h37M274 82h30v120h-30m30-60h20" stroke="currentColor" stroke-width="2" opacity=".45" />
      <g v-for="y in [31, 91, 151, 211]" :key="y">
        <rect x="22" :y="y" width="104" height="42" rx="7" fill="var(--cinema-panel)" stroke="currentColor" stroke-opacity=".25" />
        <circle cx="43" :cy="y + 21" r="9" fill="currentColor" opacity=".2" />
        <path :d="`M62 ${y + 16}h44m-44 10h29`" stroke="currentColor" stroke-width="3" opacity=".4" />
      </g>
      <g v-for="y in [61, 181]" :key="y">
        <rect x="194" :y="y" width="80" height="42" rx="7" fill="var(--lime)" stroke="currentColor" stroke-opacity=".25" />
        <path :d="`M213 ${y + 16}h40m-40 10h25`" stroke="#142823" stroke-width="3" opacity=".65" />
      </g>
      <circle cx="347" cy="142" r="24" fill="var(--lime)" />
      <path d="m336 142 7 7 15-15" stroke="#142823" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" />
    </template>
  </svg>
</template>
