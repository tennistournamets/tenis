// Client-side request timeout for the Supabase client. Without it a stalled request
// (overloaded database, half-open connection) keeps a button busy forever and blocks
// navigation. The rejection is a TimeoutError, which errorMessages.js translates.
export const REQUEST_TIMEOUT_MS = 30000

export function createTimeoutFetch(baseFetch = globalThis.fetch, timeoutMs = REQUEST_TIMEOUT_MS) {
  return function timeoutFetch(input, init = {}) {
    const controller = new AbortController()
    const outer = init.signal
    let timedOut = false
    const onAbort = () => controller.abort(outer.reason)
    if (outer) {
      if (outer.aborted) controller.abort(outer.reason)
      else outer.addEventListener('abort', onAbort, { once: true })
    }
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
    return baseFetch(input, { ...init, signal: controller.signal })
      .catch(error => {
        if (!timedOut) throw error
        const timeout = new Error(`Request timed out after ${Math.round(timeoutMs / 1000)} s`)
        timeout.name = 'TimeoutError'
        throw timeout
      })
      .finally(() => { clearTimeout(timer); outer?.removeEventListener('abort', onAbort) })
  }
}
