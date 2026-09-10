import { onBeforeUnmount, onMounted } from 'vue'

// Adds `.is-in` to `.reveal` elements once they scroll into view.
// Falls back to showing everything if IntersectionObserver is missing.
export function useReveal(rootRef, { selector = '.reveal', threshold = 0.12 } = {}) {
  let observer = null

  onMounted(() => {
    const root = rootRef.value || document
    const els = Array.from(root.querySelectorAll(selector))
    if (!('IntersectionObserver' in window)) {
      els.forEach((el) => el.classList.add('is-in'))
      return
    }
    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-in')
            observer.unobserve(entry.target)
          }
        }
      },
      { threshold, rootMargin: '0px 0px -6% 0px' },
    )
    els.forEach((el) => observer.observe(el))
  })

  onBeforeUnmount(() => {
    if (observer) observer.disconnect()
    observer = null
  })
}
