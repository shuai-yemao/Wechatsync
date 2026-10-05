import { parseHTML } from 'linkedom'

export interface OneNotePageContent {
  title: string
  html: string
  sourceUrl: string
  warnings: string[]
  missingImages?: string[]
}

interface PageMetadata {
  id: string
  title: string
  links?: { oneNoteClientUrl?: { href: string }; oneNoteWebUrl?: { href: string } }
}

const GRAPH = 'https://graph.microsoft.com/v1.0/me/onenote'
const MiB = 1024 * 1024
const ALLOWED_TAGS = new Set('p div span br h1 h2 h3 h4 h5 h6 strong b em i u s del sub sup ul ol li pre code blockquote hr table thead tbody tfoot tr td th a img'.split(' '))
const DROP_TAGS = 'script,style,iframe,frame,object,embed,svg,math,form,input,button,textarea,select,video,audio,canvas,link,meta,base'

function decode(value: string): string {
  for (let i = 0; i < 3; i++) {
    try { const next = decodeURIComponent(value); if (next === value) break; value = next } catch { break }
  }
  return value
}

/** Page GUID is used only for matching Graph metadata links, never as a Graph page id. */
export function oneNotePageGuid(source: string): string | undefined {
  const value = decode(source)
  const match = value.match(/(?:[?#&]|^)page-?id=\{?([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\}?/i)
  return match?.[1].toLowerCase()
}

function normalizeLink(source: string): string {
  const stripped = decode(source.trim()).replace(/^onenote:/i, '')
  try {
    const url = new URL(stripped)
    url.searchParams.sort()
    return url.href
  } catch { return stripped }
}

export function validateOneNoteSource(source: string): void {
  if (source.length > 16_384) throw new Error('OneNote 链接过长。')
  if (/^onenote:/i.test(source) && oneNotePageGuid(source)) return
  let url: URL
  try { url = new URL(source) } catch { throw new Error('请输入 OneNote 在线页面链接，或包含 page-id 的 OneNote 页面深链。') }
  const host = url.hostname.toLowerCase()
  const known = host === 'onenote.com' || host.endsWith('.onenote.com') || host.endsWith('.officeapps.live.com') || host === 'onedrive.live.com' || host.endsWith('.sharepoint.com')
  if (url.protocol !== 'https:' || !known || url.username || url.password) {
    throw new Error('该链接不是受支持的 OneNote 在线页面；短链接请先在浏览器打开并复制页面链接。')
  }
}

export function matchesOneNotePage(source: string, page: PageMetadata): boolean {
  const links = [page.links?.oneNoteClientUrl?.href, page.links?.oneNoteWebUrl?.href].filter((link): link is string => !!link)
  const guid = oneNotePageGuid(source)
  return links.some(link => normalizeLink(link) === normalizeLink(source) || (!!guid && oneNotePageGuid(link) === guid))
}

function graphUrl(source: string): string {
  const url = new URL(source)
  if (url.origin !== 'https://graph.microsoft.com' || url.username || url.password || !/^\/v1\.0\/(?:me|users\/[^/]+|groups\/[^/]+|sites\/[^/]+)\/onenote\//.test(url.pathname)) {
    throw new Error('OneNote 返回了不可信的 Graph 资源地址。')
  }
  return url.href
}

function imageResourceUrl(source: string): string | undefined {
  let url: URL
  try { url = new URL(source) } catch { return undefined }
  if (url.origin === 'https://graph.microsoft.com') return graphUrl(source)
  // OneNote output HTML may still use the legacy OneNote API resource URI.
  if (url.protocol === 'https:' && (url.hostname === 'www.onenote.com' || url.hostname === 'onenote.com')) {
    const resource = url.pathname.match(/\/resources\/([^/]+)\/\$value$/)
    if (resource) return `${GRAPH}/resources/${resource[1]}/$value`
  }
  return undefined
}

async function readBounded(response: Response, limit: number): Promise<Uint8Array> {
  const size = Number(response.headers.get('Content-Length'))
  if (Number.isFinite(size) && size > limit) throw new Error('OneNote 内容超过导入大小限制。')
  if (!response.body) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > limit) throw new Error('OneNote 内容超过导入大小限制。')
      chunks.push(value)
    }
  } catch (error) { await reader.cancel(); throw error } finally { reader.releaseLock() }
  const result = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length }
  return result
}

async function graphGet(source: string, token: string, limit: number): Promise<{ bytes: Uint8Array; type: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30_000)
  try {
    const response = await fetch(graphUrl(source), { headers: { Authorization: `Bearer ${token}` },
      credentials: 'omit', redirect: 'error', signal: controller.signal })
    if (response.status === 401) throw new Error('OneNote 授权已失效，请断开后重新授权。')
    if (response.status === 403) throw new Error('当前 Microsoft 账户无权读取这篇 OneNote 笔记，或 Notes.Read 许可未授予。')
    if (response.status === 429) throw new Error('OneNote 请求过于频繁，请稍后重试。')
    if (!response.ok) throw new Error(`OneNote 读取失败（HTTP ${response.status}）。`)
    return { bytes: await readBounded(response, limit), type: response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() || '' }
  } finally { clearTimeout(timer) }
}

/** Service worker-safe. Access token is never returned to the UI or sent to image hosts. */
export async function readOneNotePage(sourceUrl: string, accessToken: string): Promise<OneNotePageContent> {
  validateOneNoteSource(sourceUrl)
  if (!accessToken) throw new Error('请先授权 OneNote。')
  let next: string | undefined = `${GRAPH}/pages?$select=id,title,links&$top=100`
  const seen = new Set<string>()
  let page: PageMetadata | undefined
  while (next) {
    if (seen.has(next) || seen.size >= 100) throw new Error('OneNote 页面列表超过查询上限或分页异常；请使用当前账户可访问的具体页面链接。')
    seen.add(next)
    const response = await graphGet(next, accessToken, 5 * MiB)
    const data = JSON.parse(new TextDecoder().decode(response.bytes))
    if (!Array.isArray(data.value)) throw new Error('OneNote 页面列表响应无效。')
    page = data.value.find((item: PageMetadata) => typeof item.id === 'string' && matchesOneNotePage(sourceUrl, item))
    if (page) break
    next = data['@odata.nextLink']
    if (next) graphUrl(next)
  }
  if (!page) throw new Error('未能在当前账户的笔记中匹配此页面。请复制具体页面链接；共享、其他租户或桌面本地笔记可能不在 /me 可访问范围。')
  const content = await graphGet(`${GRAPH}/pages/${encodeURIComponent(page.id)}/content`, accessToken, 5 * MiB)
  const { document } = parseHTML(new TextDecoder().decode(content.bytes))
  const warnings: string[] = []
  if (document.querySelector('object,video,audio,svg,canvas')) warnings.push('OneNote 附件、音视频、墨迹或绘图暂不导入；请在来源笔记中查看。')
  document.querySelectorAll(DROP_TAGS).forEach(node => node.remove())
  const body = document.body
  // Allowlist strips event handlers, style URLs and arbitrary active elements.
  for (const element of Array.from(body.querySelectorAll('*'))) {
    const tag = element.tagName.toLowerCase()
    if (!ALLOWED_TAGS.has(tag)) { element.replaceWith(...Array.from(element.childNodes)); continue }
    const keep = new Set(tag === 'img' ? ['src', 'alt', 'data-fullres-src'] : tag === 'a' ? ['href', 'title'] : tag === 'pre' ? ['data-lang'] : tag === 'code' ? ['class'] : ['colspan', 'rowspan'])
    for (const attr of Array.from(element.attributes)) if (!keep.has(attr.name.toLowerCase())) element.removeAttribute(attr.name)
    if (tag === 'code' && !/^language-[a-zA-Z0-9+#._-]{1,32}$/.test(element.getAttribute('class') || '')) element.removeAttribute('class')
    if (tag === 'pre' && !/^[a-zA-Z0-9+#._-]{1,32}$/.test(element.getAttribute('data-lang') || '')) element.removeAttribute('data-lang')
    if (tag === 'a') {
      const href = element.getAttribute('href') || ''
      if (!/^(?:https?:\/\/|mailto:)/i.test(href)) element.removeAttribute('href')
    }
  }
  let imageTotal = 0
  const missingImages: string[] = []
  for (const image of Array.from(body.querySelectorAll('img'))) {
    const source = image.getAttribute('data-fullres-src') || image.getAttribute('src') || ''
    image.removeAttribute('data-fullres-src')
    const resource = imageResourceUrl(source)
    if (resource) {
      const result = await graphGet(resource, accessToken, Math.min(10 * MiB, 50 * MiB - imageTotal))
      if (!/^image\/(?:png|jpeg|gif|webp)$/.test(result.type)) throw new Error('OneNote 图片返回了不支持或不安全的格式。')
      imageTotal += result.bytes.length
      let binary = ''
      for (let offset = 0; offset < result.bytes.length; offset += 32_768) binary += String.fromCharCode(...result.bytes.subarray(offset, offset + 32_768))
      image.setAttribute('src', `data:${result.type};base64,${btoa(binary)}`)
    } else if (/^https:\/\//i.test(source)) {
      image.setAttribute('src', source)
      warnings.push('外部图片保留原链接，未发送 Microsoft token；目标平台上传时仍需读取。')
    } else {
      missingImages.push(source || image.getAttribute('alt') || '(空图片地址)')
      image.replaceWith(document.createTextNode(`[图片未导入：${image.getAttribute('alt') || '不支持的资源'}]`))
      warnings.push('部分图片地址不受支持，已显示缺失提示。')
    }
  }
  return { title: page.title || 'OneNote 笔记', html: body.innerHTML,
    sourceUrl: page.links?.oneNoteWebUrl?.href || sourceUrl, warnings: [...new Set(warnings)], missingImages }
}
