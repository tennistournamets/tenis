// Loads src/i18n/messages.js, whose imports are extensionless (Vite style), under node:test.
import * as nodeModule from 'node:module'

const resolver = `
export async function resolve(specifier, context, next) {
  try { return await next(specifier, context) }
  catch (error) {
    if (error?.code !== 'ERR_MODULE_NOT_FOUND' || !/^\\.\\.?\\//.test(specifier) || /\\.[cm]?js$/.test(specifier)) throw error
    return next(specifier + '.js', context)
  }
}`
const relative = specifier => /^\.\.?\//.test(specifier) && !/\.[cm]?js$/.test(specifier)
if (nodeModule.registerHooks) {
  nodeModule.registerHooks({
    resolve(specifier, context, next) {
      try { return next(specifier, context) }
      catch (error) {
        if (error?.code !== 'ERR_MODULE_NOT_FOUND' || !relative(specifier)) throw error
        return next(`${specifier}.js`, context)
      }
    },
  })
} else {
  nodeModule.register(`data:text/javascript,${encodeURIComponent(resolver)}`, import.meta.url)
}

export const { messages } = await import('../../src/i18n/messages.js')

/** Value at a dotted path, or undefined. */
export function lookup(locale, key) {
  return key.split('.').reduce((node, part) => node?.[part], messages[locale])
}

/** Minimal vue-i18n style `t` for one locale: {named} interpolation and `a | b | c` plurals. */
export function makeT(locale) {
  return (key, params = {}) => {
    const value = lookup(locale, key)
    if (typeof value !== 'string') return key
    const fill = text => text.replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? params.n ?? params.count ?? ''))
    return fill(value)
  }
}
