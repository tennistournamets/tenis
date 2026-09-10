// Automatic activation for native buttons in a tablist; disabled tabs are skipped.
export function onTabKeydown(event) {
  const list = event.currentTarget
  const vertical = list.getAttribute('aria-orientation') === 'vertical'
  const previous = vertical ? 'ArrowUp' : 'ArrowLeft'
  const next = vertical ? 'ArrowDown' : 'ArrowRight'
  if (![previous, next, 'Home', 'End'].includes(event.key)) return
  const tabs = [...list.querySelectorAll('[role="tab"]')].filter(tab =>
    tab.closest('[role="tablist"]') === list && !tab.disabled && tab.getAttribute('aria-disabled') !== 'true',
  )
  const index = tabs.indexOf(event.target)
  if (index < 0) return
  const target = event.key === 'Home' ? tabs[0]
    : event.key === 'End' ? tabs.at(-1)
      : tabs[(index + (event.key === next ? 1 : -1) + tabs.length) % tabs.length]
  event.preventDefault()
  event.stopPropagation()
  target.focus()
  target.click()
}
