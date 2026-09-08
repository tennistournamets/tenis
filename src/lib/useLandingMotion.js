import { computed, onBeforeUnmount, ref } from 'vue'

// Read before the first render: an opted-out visitor never requests Three.js.
export function useLandingMotion() {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
  const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection
  const prefersReduced = ref(reduced.matches)
  const savesData = ref(false)
  const optedIn = ref(true)
  const failed = ref(false)
  const forcedOff = new URLSearchParams(window.location.search).has('no3d')
  try { optedIn.value = localStorage.getItem('champ_landing3d') !== 'off' } catch { /* Storage may be unavailable. */ }

  const updateNetwork = () => {
    savesData.value = Boolean(connection?.saveData || ['2g', 'slow-2g'].includes(connection?.effectiveType))
  }
  const updateMotion = event => { prefersReduced.value = event.matches }
  const updateStorage = event => {
    if (event.key === 'champ_landing3d' || event.key === null) optedIn.value = event.newValue !== 'off'
  }
  updateNetwork()
  reduced.addEventListener?.('change', updateMotion)
  connection?.addEventListener?.('change', updateNetwork)
  window.addEventListener('storage', updateStorage)
  onBeforeUnmount(() => {
    reduced.removeEventListener?.('change', updateMotion)
    connection?.removeEventListener?.('change', updateNetwork)
    window.removeEventListener('storage', updateStorage)
  })

  const reason = computed(() => prefersReduced.value ? 'motionReduced' : savesData.value ? 'motionData' : forcedOff ? 'motionPreview' : failed.value ? 'motionUnavailable' : '')
  const enabled = computed(() => optedIn.value && !reason.value)
  function toggle() {
    if (reason.value) return
    optedIn.value = !optedIn.value
    try { localStorage.setItem('champ_landing3d', optedIn.value ? 'on' : 'off') } catch { /* Keep the choice for this visit. */ }
  }
  return { enabled, reason, failed, toggle }
}
