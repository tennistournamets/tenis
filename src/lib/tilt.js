// v-tilt: pointer-tracking 3D tilt (CSS perspective) for cards.
// Skipped for coarse pointers and prefers-reduced-motion.
const finePointer = () => window.matchMedia && window.matchMedia('(pointer: fine)').matches
const reducedMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches

export const tilt = {
  mounted(el, binding) {
    if (!finePointer() || reducedMotion()) return
    const max = Number(binding.value) || 6
    let raf = 0
    let nx = 0
    let ny = 0
    let resetTimer = 0
    el.classList.add('tilt')

    const apply = () => {
      raf = 0
      el.style.setProperty('--tilt-x', `${(-ny * max).toFixed(2)}deg`)
      el.style.setProperty('--tilt-y', `${(nx * max).toFixed(2)}deg`)
    }
    const onMove = (e) => {
      const r = el.getBoundingClientRect()
      if (!r.width || !r.height) return
      nx = ((e.clientX - r.left) / r.width) * 2 - 1
      ny = ((e.clientY - r.top) / r.height) * 2 - 1
      if (!raf) raf = requestAnimationFrame(apply)
    }
    const onEnter = () => {
      clearTimeout(resetTimer)
      el.classList.remove('tilt--reset')
    }
    const onLeave = () => {
      nx = 0
      ny = 0
      el.classList.add('tilt--reset')
      if (!raf) raf = requestAnimationFrame(apply)
      resetTimer = setTimeout(() => el.classList.remove('tilt--reset'), 500)
    }

    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerenter', onEnter)
    el.addEventListener('pointerleave', onLeave)
    el.__tilt = () => {
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerenter', onEnter)
      el.removeEventListener('pointerleave', onLeave)
      if (raf) cancelAnimationFrame(raf)
      clearTimeout(resetTimer)
    }
  },
  unmounted(el) {
    if (el.__tilt) el.__tilt()
    delete el.__tilt
  },
}
