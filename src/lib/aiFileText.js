// An attached file as plain text for the AI (DeepSeek reads text only). The file never leaves
// the browser: only its text is sent. Pictures (screenshots, photos of a list) are read by
// tesseract.js in the browser too. Each parser loads when such a file is picked, so the
// main bundle does not grow.
const IMAGE_TYPES = ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif']
export const FILE_ACCEPT = `.txt,.csv,.tsv,.xlsx,.docx,.pdf,${IMAGE_TYPES.map(ext => `.${ext}`).join(',')}`
export const FILE_MAX_BYTES = 5 * 1024 * 1024
export const IMAGE_MAX_BYTES = 15 * 1024 * 1024
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

// Recognition works best on large, dark-on-light text: small screenshots are scaled up,
// colours dropped, and a dark-theme chat (light text on dark) is inverted.
export function prepareForOcr(pixels) {
  let sum = 0
  for (let i = 0; i < pixels.length; i += 4) {
    const grey = 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2]
    pixels[i] = pixels[i + 1] = pixels[i + 2] = grey
    sum += grey
  }
  const dark = sum / (pixels.length / 4) < 110
  if (dark) for (let i = 0; i < pixels.length; i += 4) pixels[i] = pixels[i + 1] = pixels[i + 2] = 255 - pixels[i]
  return dark
}

async function imageCanvas(file) {
  let bitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    // Chrome and Firefox cannot open HEIC; iPhones usually send JPEG from the file picker.
    throw new FileTextError('imageType')
  }
  const scale = Math.min(3, Math.max(1, 1600 / bitmap.width))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  const context = canvas.getContext('2d', { willReadFrequently: true })
  context.imageSmoothingQuality = 'high'
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close?.()
  const image = context.getImageData(0, 0, canvas.width, canvas.height)
  prepareForOcr(image.data)
  context.putImageData(image, 0, 0)
  return canvas
}

async function imageText(file, onProgress) {
  const [{ createWorker }, canvas] = await Promise.all([import('tesseract.js'), imageCanvas(file)])
  // Worker, engine and lt/ru/en data come from our own domain (scripts/vite-ocr-assets.js).
  // Absolute: tesseract.js starts its worker from a blob URL, where "/ocr/..." resolves nowhere.
  const base = new URL(typeof __OCR_BASE__ === 'string' ? __OCR_BASE__ : '/ocr', window.location.origin).href
  const worker = await createWorker(['lit', 'rus', 'eng'], 1, {
    workerPath: `${base}/worker.min.js`,
    corePath: `${base}/core`,
    langPath: `${base}/lang`,
    logger: message => {
      if (message.status === 'recognizing text') onProgress?.(Math.round(message.progress * 100))
    },
  })
  try {
    const { data } = await worker.recognize(canvas)
    return data.text
  } finally {
    await worker.terminate()
  }
}

/**
 * Text of a .txt/.csv/.tsv/.xlsx/.docx/.pdf file or a picture; throws FileTextError
 * (type, imageType, tooBig, noText, noImageText, unreadable). `onProgress(percent)` follows
 * picture recognition.
 */
export async function fileToText(file, { onProgress } = {}) {
  if (!file) throw new FileTextError('type')
  const ext = extension(file.name)
  const image = IMAGE_TYPES.includes(ext)
  if (file.size > (image ? IMAGE_MAX_BYTES : FILE_MAX_BYTES)) throw new FileTextError('tooBig')
  let text
  try {
    if (image) text = await imageText(file, onProgress)
    else if (['txt', 'csv', 'tsv'].includes(ext)) text = await file.text()
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
  // A scanned PDF has pictures, not text; a picture may have no readable text at all.
  if (!text) throw new FileTextError(image ? 'noImageText' : 'noText')
  return text
}

/** Text cut to what the AI accepts; `clipped` tells the organizer the end was dropped. */
export function clipText(text, max = TEXT_MAX) {
  const value = String(text ?? '')
  return value.length > max ? { text: value.slice(0, max), clipped: true } : { text: value, clipped: false }
}
