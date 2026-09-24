<script setup>
// The Bracketa mark, shared by the admin and the public header.
defineProps({ size: { type: Number, default: 24 } })
</script>

<template>
  <svg class="app-header__logo" :width="size" :height="size" viewBox="0 0 28 28" fill="none" aria-hidden="true">
    <rect width="28" height="28" rx="8" fill="var(--primary)" />
    <path d="M11 8H9.5A1.5 1.5 0 0 0 8 9.5v9A1.5 1.5 0 0 0 9.5 20H11" stroke="#fff" stroke-width="2" stroke-linecap="round" fill="none" />
    <path d="M17 8h1.5A1.5 1.5 0 0 1 20 9.5v9a1.5 1.5 0 0 1-1.5 1.5H17" stroke="#fff" stroke-width="2" stroke-linecap="round" fill="none" />
    <circle cx="14" cy="14" r="2.2" fill="var(--lime)" />
  </svg>
</template>
