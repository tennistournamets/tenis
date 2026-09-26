// Typed text <-> the datetime-local model string ("yyyy-MM-ddTHH:mm", local time) of DateTimeField.
const pad = n => String(n).padStart(2, '0')

/** "dd.MM.yyyy HH:mm" for a model string, '' for an empty or invalid one. */
export function formatDateTimeText(model) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(model || '')
  return m ? `${m[3]}.${m[2]}.${m[1]} ${m[4]}:${m[5]}` : ''
}

/**
 * Parses what the user typed. Returns the model string for a complete, real date and
 * time; '' for empty text; null while the text is incomplete or not a real date.
 * Accepts d.M.yyyy with optional leading zeros and space/comma/T before H:mm.
 */
export function parseDateTimeText(text) {
  const value = String(text ?? '').trim()
  if (!value) return ''
  const m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})(?:\s*[,T]?\s*)(\d{1,2})[:.](\d{2})$/.exec(value)
  if (!m) return null
  const [day, month, year, hours, minutes] = m.slice(1).map(Number)
  if (hours > 23 || minutes > 59) return null
  const d = new Date(year, month - 1, day, hours, minutes)
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return null
  return `${year}-${pad(month)}-${pad(day)}T${pad(hours)}:${pad(minutes)}`
}
