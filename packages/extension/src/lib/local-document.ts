import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import { marked } from 'marked'
import { parseHTML } from 'linkedom'

export const LOCAL_LIMITS = { text: 5 * 1024 * 1024, image: 10 * 1024 * 1024, total: 50 * 1024 * 1024 }

/** Files remain in the importing page; only a prepared article is sent to the worker. */
export interface LocalFile {
  name: string
  size: number
  type: string
  webkitRelativePath?: string
  text(): Promise<string>
  arrayBuffer(): Promise<ArrayBuffer>
}

export interface PreparedLocalDocument {
  title: string
  markdown?: string
  html: string
  warnings: string[]
  missingImages: string[]
  imageCount: number
  sourceUrl?: string
}

interface AstNode {
  type: string
  value?: string
  url?: string
  identifier?: string
  alt?: string
  children?: AstNode[]
  position?: { start: { offset?: number }; end: { offset?: number } }
}

export function localPath(file: LocalFile): string {
  return (file.webkitRelativePath || file.name).replace(/\\/g, '/')
}

function normalizePath(path: string): string | null {
  const parts: string[] = []
  for (const part of path.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (!parts.length) return null
      parts.pop()
    } else parts.push(part)
  }
  return parts.join('/')
}

/** Exact directory-relative paths win. Loose selection allows only unique basenames. */
export function resolveLocalImage(reference: string, document: LocalFile, files: LocalFile[]): LocalFile | null {
  let decoded: string
  try { decoded = decodeURIComponent(reference.split(/[?#]/, 1)[0]) } catch { return null }
  if (/^(?:[a-z][\w+.-]*:|\/)/i.test(decoded)) return null
  const docPath = localPath(document)
  const directory = docPath.includes('/') ? docPath.slice(0, docPath.lastIndexOf('/') + 1) : ''
  const target = normalizePath(directory + decoded)
  if (!target) return null
  const hasDirectory = !!document.webkitRelativePath
  if (hasDirectory && target.split('/')[0] !== docPath.split('/')[0]) return null
  const exact = files.filter(file => localPath(file) === target)
  if (exact.length === 1) return exact[0]
  if (hasDirectory || exact.length > 1) return null
  const basename = target.split('/').pop()
  const candidates = files.filter(file => file.name === basename)
  return candidates.length === 1 ? candidates[0] : null
}

function rasterMime(bytes: Uint8Array): string | null {
  const ascii = (start: number, length: number) => String.fromCharCode(...bytes.slice(start, start + length))
  if (bytes[0] === 0x89 && ascii(1, 3) === 'PNG' && bytes[4] === 13 && bytes[5] === 10) return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') return 'image/gif'
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'image/webp'
  return null
}

async function fileDataUrl(file: LocalFile): Promise<string> {
  if (file.size > LOCAL_LIMITS.image) throw new Error(`图片超过 10 MiB：${file.name}`)
  const bytes = new Uint8Array(await file.arrayBuffer())
  const mime = rasterMime(bytes)
  if (!mime) throw new Error(`仅支持 PNG、JPEG、GIF、WebP 图片：${file.name}`)
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
  }
  return `data:${mime};base64,${btoa(binary)}`
}

const ALLOWED = new Set('p div span h1 h2 h3 h4 h5 h6 ul ol li blockquote pre code strong b em i del s hr br table thead tbody tr th td a img figure figcaption details summary'.split(' '))
const REMOVE = new Set('script style iframe object embed form input button textarea select link meta base svg math template'.split(' '))

/** Parse inertly and retain a small formatting allowlist; no source attributes execute. */
export async function sanitizeLocalHtml(html: string, imageResolver: (src: string) => Promise<string | null>): Promise<string> {
  const { document } = parseHTML(`<html><body>${html}</body></html>`)
  const root = document.body
  const walk = async (parent: Element) => {
    for (const element of Array.from(parent.children)) {
      const tag = element.tagName.toLowerCase()
      if (REMOVE.has(tag)) { element.remove(); continue }
      await walk(element)
      if (!ALLOWED.has(tag)) { element.replaceWith(...Array.from(element.childNodes)); continue }
      const href = element.getAttribute('href') || ''
      const src = element.getAttribute('src') || ''
      const alt = element.getAttribute('alt') || ''
      const lang = element.getAttribute('class')?.match(/(?:^|\s)language-([\w+-]+)/)?.[1]
      const title = element.getAttribute('title') || ''
      for (const attr of Array.from(element.attributes)) element.removeAttribute(attr.name)
      if (tag === 'a' && /^(?:https?:\/\/|mailto:|#)/i.test(href.trim())) {
        element.setAttribute('href', href.trim())
        element.setAttribute('rel', 'noopener noreferrer')
      }
      if (tag === 'code' && lang) element.setAttribute('class', `language-${lang}`)
      if (title) element.setAttribute('title', title)
      if (tag === 'img') {
        const resolved = await imageResolver(src)
        if (resolved) element.setAttribute('src', resolved)
        element.setAttribute('alt', alt)
      }
    }
  }
  await walk(root)
  return root.innerHTML
}

export async function prepareLocalDocument(documentFile: LocalFile, files: LocalFile[]): Promise<PreparedLocalDocument> {
  if (documentFile.size > LOCAL_LIMITS.text) throw new Error('文档超过 5 MiB')
  const selected = Array.from(new Set([documentFile, ...files]))
  if (selected.reduce((sum, file) => sum + file.size, 0) > LOCAL_LIMITS.total) throw new Error('所选文件总量超过 50 MiB')
  if (!/\.(?:md|markdown|html?)$/i.test(documentFile.name)) throw new Error('请选择 Markdown 或 HTML 文档')
  let text = await documentFile.text()
  if (new TextEncoder().encode(text).byteLength > LOCAL_LIMITS.text) throw new Error('文档超过 5 MiB')
  const warnings = new Set<string>()
  const missing = new Set<string>()
  const cache = new Map<string, Promise<string | null>>()
  const imageResolver = (src: string): Promise<string | null> => {
    if (cache.has(src)) return cache.get(src)!
    const resolve = async () => {
      if (/^https?:\/\//i.test(src)) {
        warnings.add('远程图片在同步时读取；离线预览不加载远程资源。')
        return src
      }
      if (/^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(src)) {
        if (src.length * 0.75 > LOCAL_LIMITS.image) throw new Error('嵌入图片超过 10 MiB')
        return src
      }
      const file = resolveLocalImage(src, documentFile, files)
      if (!file) { missing.add(src || '(空图片地址)'); return null }
      return fileDataUrl(file)
    }
    const pending = resolve()
    cache.set(src, pending)
    return pending
  }
  let markdown: string | undefined
  let title = documentFile.name.replace(/\.(?:md|markdown|html?)$/i, '')
  if (/\.(?:md|markdown)$/i.test(documentFile.name)) {
    const tree = unified().use(remarkParse).use(remarkGfm).parse(text) as AstNode
    const nodes: AstNode[] = []
    const collect = (node: AstNode) => { nodes.push(node); node.children?.forEach(collect) }
    collect(tree)
    const definitions = new Map(nodes.filter(node => node.type === 'definition').map(node => [node.identifier, node.url]))
    const firstHeading = nodes.find(node => node.type === 'heading')
    const plain = (node: AstNode): string => node.value || node.children?.map(plain).join('') || ''
    if (firstHeading) title = plain(firstHeading) || title
    const replacements: { start: number; end: number; value: string }[] = []
    for (const node of nodes) {
      const start = node.position?.start.offset
      const end = node.position?.end.offset
      if (start === undefined || end === undefined) continue
      if (node.type === 'image' || node.type === 'imageReference') {
        const src = node.url || definitions.get(node.identifier) || ''
        const resolved = await imageResolver(src)
        const alt = (node.alt || '').replace(/[\\\[\]]/g, '\\$&')
        replacements.push({ start, end, value: resolved ? `![${alt}](<${resolved}>)` : `[缺失图片：${alt || src}]` })
      } else if (node.type === 'html') {
        warnings.add('HTML 按安全白名单清理；脚本、样式和嵌入组件不会上传。')
        replacements.push({ start, end, value: await sanitizeLocalHtml(node.value || '', imageResolver) })
      } else if (node.type === 'link' && node.url && !/^(?:https?:\/\/|mailto:|#)/i.test(node.url)) {
        warnings.add('非网站链接已转换为纯文本。')
        replacements.push({ start, end, value: plain(node) })
      } else if (node.type === 'definition' && node.url && !/^(?:https?:\/\/|mailto:|#)/i.test(node.url)) {
        replacements.push({ start, end, value: '' })
      }
    }
    const independent = replacements.filter(item => !replacements.some(outer => outer !== item && outer.start <= item.start && outer.end >= item.end))
    for (const replacement of independent.sort((a, b) => b.start - a.start)) {
      text = text.slice(0, replacement.start) + replacement.value + text.slice(replacement.end)
    }
    markdown = text
  } else {
    const parsed = parseHTML(text)
    title = parsed.document.querySelector('title')?.textContent?.trim() || title
    text = parsed.document.body.innerHTML || text
    warnings.add('HTML 按安全白名单清理；脚本、样式和嵌入组件不会上传。')
  }
  const html = await sanitizeLocalHtml(markdown === undefined ? text : await marked.parse(markdown), imageResolver)
  const imageCount = parseHTML(`<html><body>${html}</body></html>`).document.querySelectorAll('img').length
  return { title, markdown, html, warnings: [...warnings], missingImages: [...missing], imageCount }
}

/** sandbox plus CSP prevents remote requests and navigation in the local preview. */
export function previewDocument(html: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><style>body{font:16px/1.7 system-ui;padding:24px;overflow-wrap:anywhere}img{max-width:100%}pre{white-space:pre-wrap;background:#f3f4f6;padding:16px}table{border-collapse:collapse}td,th{border:1px solid #ddd;padding:6px}a{color:#2563eb}</style></head><body>${html}</body></html>`
}
