<script setup>
import { useI18n } from 'vue-i18n'
import { phoneHref } from '../../lib/entryContacts'

// One applicant's phone and email under their name in the organizer's lists.
defineProps({ contact: { type: Object, default: null } })
const { t } = useI18n()
</script>

<template>
  <span v-if="contact && (contact.phone || contact.email)" class="entry-contact">
    <a v-if="contact.phone" class="entry-contact__link" :href="phoneHref(contact.phone)" :title="t('lifecycle.phone')">{{ contact.phone }}</a>
    <a v-if="contact.email" class="entry-contact__link" :href="`mailto:${contact.email}`" :title="t('lifecycle.email')">{{ contact.email }}</a>
  </span>
</template>

<style scoped>
.entry-contact {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 12px;
  margin-top: 2px;
  font-size: 0.8125rem;
  font-weight: 400;
  color: var(--muted);
}
.entry-contact__link { color: inherit; overflow-wrap: anywhere; text-decoration: none; }
.entry-contact__link:hover, .entry-contact__link:focus-visible { color: var(--primary); text-decoration: underline; }
</style>
