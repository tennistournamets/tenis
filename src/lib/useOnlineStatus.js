import { onBeforeUnmount, onMounted, readonly, ref } from 'vue'

export function useOnlineStatus() {
  const isOnline = ref(typeof navigator === 'undefined' || navigator.onLine !== false)

  const markOnline = () => { isOnline.value = true }
  const markOffline = () => { isOnline.value = false }

  onMounted(() => {
    isOnline.value = navigator.onLine !== false
    window.addEventListener('online', markOnline)
    window.addEventListener('offline', markOffline)
  })

  onBeforeUnmount(() => {
    window.removeEventListener('online', markOnline)
    window.removeEventListener('offline', markOffline)
  })

  return readonly(isOnline)
}
