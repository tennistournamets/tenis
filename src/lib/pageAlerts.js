// Page-level error/notice banners of the admin tournament page.
// - notices disappear by themselves after NOTICE_MS;
// - both belong to the tab they were raised on and are cleared on a tab switch;
// - an error raised while the banner is scrolled out of view is brought into view
//   (the banner sits at the top of a long page, far from the button that failed).
import { nextTick, watch } from 'vue'

export const NOTICE_MS = 8000

export function isInViewport(el, win = globalThis.window) {
  if (!el?.getBoundingClientRect || !win) return true
  const rect = el.getBoundingClientRect()
  return rect.bottom > 0 && rect.top < (win.innerHeight || 0)
}

export function usePageAlerts({ errorText, noticeText, activeTab, alertEl, keepError = () => false,
  noticeMs = NOTICE_MS, win = globalThis.window }) {
  let timer = null
  const stopNotice = watch(noticeText, value => {
    clearTimeout(timer)
    timer = value ? setTimeout(() => { noticeText.value = '' }, noticeMs) : null
  })
  const stopTab = activeTab ? watch(activeTab, () => {
    noticeText.value = ''
    if (!keepError()) errorText.value = ''
  }) : () => {}
  const stopError = watch(errorText, async value => {
    if (!value) return
    await nextTick()
    const el = alertEl?.value
    if (el && !isInViewport(el, win)) el.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
  })
  return () => { clearTimeout(timer); stopNotice(); stopTab(); stopError() }
}
