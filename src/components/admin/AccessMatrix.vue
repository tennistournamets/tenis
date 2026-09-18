<script setup>
import { useI18n } from 'vue-i18n'
import { ROLE_MATRIX, ROLES } from '../../lib/access'

const { t } = useI18n()
const roleLabel = role => t(role === 'owner' ? 'access.roleOwner' : role === 'editor' ? 'access.roleEditor' : 'access.roleCounter')
</script>

<template>
  <div class="access-matrix">
    <p class="muted access-matrix__intro">{{ t('access.matrixIntro') }}</p>
    <div class="access-matrix__scroll">
      <table class="access-matrix__table">
        <thead>
          <tr>
            <th scope="col"><span class="sr-only">{{ t('admin.role') }}</span></th>
            <th v-for="role in ROLES" :key="role" scope="col">{{ roleLabel(role) }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in ROLE_MATRIX" :key="row.key">
            <th scope="row">{{ t(`access.capabilities.${row.key}`) }}</th>
            <td v-for="role in ROLES" :key="role" :class="row[role] ? 'access-matrix__yes' : 'access-matrix__no'">
              <span aria-hidden="true">{{ row[role] ? '✓' : '—' }}</span>
              <span class="sr-only">{{ t(row[role] ? 'access.yes' : 'access.no') }}</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <p class="muted access-matrix__hint">{{ t('access.ownerOnlyHint') }}</p>
  </div>
</template>

<style scoped>
.access-matrix { display: grid; gap: 8px; }
.access-matrix__intro, .access-matrix__hint { margin: 0; font-size: 0.84rem; }
.access-matrix__scroll { overflow-x: auto; }
.access-matrix__table { width: 100%; min-width: 420px; border-collapse: collapse; font-size: 0.88rem; }
.access-matrix__table th, .access-matrix__table td { padding: 7px 10px; border-bottom: 1px solid var(--border); text-align: left; }
.access-matrix__table thead th { font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-muted); }
.access-matrix__table tbody th { font-weight: 600; }
.access-matrix__table td { text-align: center; font-weight: 700; }
.access-matrix__yes { color: var(--primary); }
.access-matrix__no { color: var(--text-muted); }
</style>
