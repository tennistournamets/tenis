import { onBeforeUnmount, ref, toValue, watchEffect } from 'vue'

export const headerTitle = ref('')
let owner = null

export function useHeaderTitle(title) {
  const token = Symbol('page-title')
  watchEffect(() => {
    owner = token
    headerTitle.value = toValue(title) || ''
  })
  onBeforeUnmount(() => {
    if (owner === token) { owner = null; headerTitle.value = '' }
  })
}
