// Error codes the client translates (src/i18n/ai.js `errors.*`, via errorMessages.js `ai.` namespace).
export class AiError extends Error {
  constructor(code, status = 502, detail = '') {
    super(code)
    this.code = code
    this.status = status
    this.detail = detail
  }
}

// Codes raised by ai_begin_call() and the HTTP status the function answers with.
export const DB_CODES = {
  'ai.auth': 401,
  'ai.badTask': 400,
  'ai.disabled': 403,
  'ai.forbidden': 403,
  'ai.limit': 429,
}
