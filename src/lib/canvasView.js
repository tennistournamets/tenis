// Pure view math for InfiniteCanvas.

/** What a wheel event over the canvas should do: 'zoom', 'pan' or 'scroll' (leave it to the page). */
export function wheelIntent(event, fullscreen = false) {
  if (event.ctrlKey || event.metaKey) return 'zoom'
  return fullscreen ? 'pan' : 'scroll'
}

// Below this width the automatic fit keeps cards readable instead of shrinking the
// whole bracket to a quarter of its size; the rest is reached by panning.
export const NARROW_WIDTH = 640
export const READABLE_SCALE = 0.6

/**
 * Transform that fits `content` into `container`. Mode 'all' shows everything (never
 * above 100 %); mode 'readable' does the same on wide screens, but on narrow ones it
 * stops at READABLE_SCALE and anchors the bracket to the top-left corner.
 */
export function fitTransform(container, content, { mode = 'readable', padding = 40, minScale = 0.1 } = {}) {
  if (!container?.width || !container?.height || !content?.width || !content?.height) return null
  const narrow = container.width < NARROW_WIDTH
  const pad = narrow ? 12 : padding
  const fit = Math.min((container.width - pad * 2) / content.width, (container.height - pad * 2) / content.height, 1)
  const floor = mode === 'readable' && narrow ? READABLE_SCALE : minScale
  const scale = Math.max(fit, floor, minScale)
  const overflowsX = content.width * scale > container.width - pad * 2
  const overflowsY = content.height * scale > container.height - pad * 2
  return {
    scale,
    translateX: overflowsX ? pad : (container.width - content.width * scale) / 2,
    translateY: overflowsY ? pad : (container.height - content.height * scale) / 2,
  }
}
