// An attached file as plain text for the AI (DeepSeek reads text only). The file never leaves
// the browser: only its text is sent. Each parser loads when such a file is picked, so the
// main bundle does not grow.
export const FILE_ACCEPT = '.txt,.csv,.tsv,.xlsx,.docx,.pdf'
export const FILE_MAX_BYTES = 5 * 1024 * 1024
export const TEXT_MAX = 30000

export class FileTextError extends Error {
  constructor(code) {
    super(code)
    this.name = 'FileTextError'
    this.code = code // i18n: ai.file.errors.<code>
  }
}

const extension = name => String(name ?? '').toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? ''

function cellText(value) {
  if (value == null) return ''
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString().slice(0, 10)
  return String(value).replace(/\s+/g, ' ').trim()
}

async function xlsxText(file) {
  const { default: readExcelFile } = await import('read-excel-file/browser')
  const sheets = await readExcelFile(file)
  return sheets.map(({ sheet, data }) => {
    const rows = data.map(row => row.map(cellText).join('\t').replace(/\t+$/, '')).filter(row => row.trim())
    return sheets.length > 1 && rows.length ? [`# ${sheet}`, ...rows].join('\n') : rows.join('\n')
  }).filter(Boolean).join('\n\n')
}

async function docxText(file) {
  const { default: mammoth } = await import('mammoth/mammoth.browser.js')
  const { value } = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() })
  return value
}

// PDF text comes in runs, sometimes one glyph each (accented letters): a space goes in only
// where the runs have a visible gap, a line break where the PDF ends a line.
export function pageText(items) {
  let text = ''
  let end = null
  for (const item of items) {
    if (typeof item?.str !== 'string') continue
    const [a = 0, b = 0, , , x = 0] = item.transform ?? []
    const size = Math.hypot(a, b) || 10
    if (end != null && x - end > size * 0.15 && !/\s$/.test(text) && !/^\s/.test(item.str)) text += ' '
    text += item.str
    end = x + (item.width ?? 0)
    if (item.hasEOL) {
      text += '\n'
      end = null
    }
  }
  return text
}

async function pdfText(file) {
  const [pdfjs, worker] = await Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')])
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) })
  const pages = []
  try {
    const doc = await task.promise
    for (let number = 1; number <= doc.numPages; number++) {
      const page = await doc.getPage(number)
      const { items } = await page.getTextContent()
      pages.push(pageText(items))
    }
  } finally {
    task.destroy()
  }
  return pages.join('\n')
}

/** Text of a .txt/.csv/.tsv/.xlsx/.docx/.pdf file; throws FileTextError (type, tooBig, noText, unreadable). */
export async function fileToText(file) {
  if (!file) throw new FileTextError('type')
  if (file.size > FILE_MAX_BYTES) throw new FileTextError('tooBig')
  const ext = extension(file.name)
  let text
  try {
    if (['txt', 'csv', 'tsv'].includes(ext)) text = await file.text()
    else if (ext === 'xlsx') text = await xlsxText(file)
    else if (ext === 'docx') text = await docxText(file)
    else if (ext === 'pdf') text = await pdfText(file)
    else throw new FileTextError('type')
  } catch (error) {
    if (error instanceof FileTextError) throw error
    if (typeof console !== 'undefined') console.warn('[bracketa] file not read:', error)
    throw new FileTextError('unreadable')
  }
  text = String(text ?? '').replace(/\r\n?/g, '\n').replace(/ {2,}/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  // A scanned PDF has pictures, not text.
  if (!text) throw new FileTextError('noText')
  return text
}

/** Text cut to what the AI accepts; `clipped` tells the organizer the end was dropped. */
export function clipText(text, max = TEXT_MAX) {
  const value = String(text ?? '')
  return value.length > max ? { text: value.slice(0, max), clipped: true } : { text: value, clipped: false }
}
