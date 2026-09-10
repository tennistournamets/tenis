import { onBeforeUnmount, onMounted, ref } from 'vue'

export function useNarrowLayout(query = '(max-width: 720px)') {
  const matches = ref(typeof window !== 'undefined' ? window.matchMedia(query).matches : false)
  let media = null

  function update(event) {
    matches.value = event.matches
  }

  onMounted(() => {
    media = window.matchMedia(query)
    matches.value = media.matches
    media.addEventListener?.('change', update)
  })

  onBeforeUnmount(() => media?.removeEventListener?.('change', update))

  return matches
}
