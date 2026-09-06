// Shared by stacked dialogs: closing a confirmation must not unlock the page
// while its parent dialog remains open. Fixed positioning also covers iOS.
let locks = 0
let restorePage = null

function preserveStyles(element, properties) {
  const values = properties.map((property) => [property, element.style.getPropertyValue(property), element.style.getPropertyPriority(property)])
  return () => {
    for (const [property, value, priority] of values) {
      if (value) element.style.setProperty(property, value, priority)
      else element.style.removeProperty(property)
    }
  }
}

export function lockPageScroll() {
  if (locks === 0) {
    const root = document.documentElement
    const body = document.body
    const x = window.scrollX
    const y = window.scrollY
    const scrollbarWidth = Math.max(0, window.innerWidth - root.clientWidth)
    const restoreRoot = preserveStyles(root, ['overflow', 'scroll-behavior'])
    const restoreBody = preserveStyles(body, ['position', 'top', 'left', 'width', 'overflow'])

    root.style.overflow = 'hidden'
    root.style.scrollBehavior = 'auto'
    body.style.position = 'fixed'
    body.style.top = `${-y}px`
    body.style.left = `${-x}px`
    // Preserve the content width when the browser removes its scrollbar.
    body.style.width = `calc(100% - ${scrollbarWidth}px)`
    body.style.overflow = 'hidden'

    restorePage = () => {
      restoreBody()
      // Restore scroll synchronously before re-enabling the site's smooth scroll.
      window.scrollTo(x, y)
      restoreRoot()
    }
  }
  locks += 1

  let released = false
  return () => {
    if (released) return
    released = true
    locks -= 1
    if (locks === 0) {
      restorePage?.()
      restorePage = null
    }
  }
}
