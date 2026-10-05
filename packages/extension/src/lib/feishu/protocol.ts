import { parseHTML } from 'linkedom'

export interface PreparedContent {
  html: string
  text: string
  codes: string[]
  links: string[]
  imageCount: number
}

const TEXT_LIMIT = 5 * 1024 * 1024
export function feishuOrigin(value: string): string | null {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null
    if (!['feishu.cn', 'larksuite.com', 'larkoffice.com'].some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`))) return null
    if (/^(accounts?|passport|open|login)\./.test(url.hostname)) return null
    return url.origin
  } catch { return null }
}

/** Accept only the new document returned by this create call, never an arbitrary URL. */
export function createdDocument(response: unknown, origin: string): { token: string; url: string } {
  const res = response as any
  if (res?.code !== 0) throw new Error(`飞书创建失败（${String(res?.code ?? '非 JSON 响应')}）：${String(res?.msg ?? '').slice(0, 180)}`)
  const nodeId = res.data?.node_list?.[0]
  const node = res.data?.entities?.nodes?.[nodeId]
  const token = node?.obj_token
  if (typeof token !== 'string' || !/^[a-zA-Z0-9_-]{6,160}$/.test(token)) throw new Error('飞书没有返回有效的新文档标识')
  const url = new URL(node.url || `/docx/${token}`, origin)
  if (url.origin !== origin || url.pathname !== `/docx/${token}`) throw new Error('飞书返回的新文档地址不符合当前租户与文档标识')
  return { token, url: url.href }
}

/** Worker-safe allowlist; HTML is cleaned before any external side effect. */
export function prepareFeishuHtml(html: string): PreparedContent {
  if (new TextEncoder().encode(html.replace(/data:image\/(?:png|jpeg|gif|webp);base64,[a-zA-Z0-9+/=]+/g, '')).byteLength > TEXT_LIMIT) throw new Error('正文超过 5 MiB 上限')
  if (html.length > 75 * 1024 * 1024) throw new Error('内容超过导入上限')
  const { document } = parseHTML(`<html><body>${html}</body></html>`)
  const allowed = new Set('p div span br h1 h2 h3 h4 h5 h6 blockquote pre code ul ol li strong b em i s del u a img table thead tbody tr th td hr'.split(' '))
  for (const el of [...document.body.querySelectorAll('*')]) {
    const tag = el.tagName.toLowerCase()
    if (!allowed.has(tag)) {
      if (['script','style','iframe','object','embed','form','input','svg','math','template','noscript'].includes(tag)) el.remove()
      else el.replaceWith(...el.childNodes)
      continue
    }
    for (const attr of [...el.attributes]) {
      if (!((tag === 'a' && attr.name === 'href') || (tag === 'img' && ['src','alt'].includes(attr.name)) || (tag === 'code' && attr.name === 'class'))) el.removeAttribute(attr.name)
    }
    if (tag === 'a') {
      const href = el.getAttribute('href') || ''
      if (!/^(https?:\/\/|mailto:|tel:)/i.test(href)) el.removeAttribute('href')
    }
    if (tag === 'code' && !/^language-[\w+-]+$/.test(el.getAttribute('class') || '')) el.removeAttribute('class')
  }
  let bytes = 0
  for (const img of document.body.querySelectorAll('img')) {
    const src = img.getAttribute('src') || ''
    const match = src.match(/^data:image\/(png|jpeg|gif|webp);base64,([a-zA-Z0-9+/]+={0,2})$/)
    if (match) {
      const size = Math.floor(match[2].length * 3 / 4) - (match[2].endsWith('==') ? 2 : match[2].endsWith('=') ? 1 : 0)
      if (size > 10 * 1024 * 1024) throw new Error('单张图片超过 10 MiB 上限')
      bytes += size
    } else if (!/^https:\/\//i.test(src)) throw new Error('图片未解析为本地内嵌图片或 HTTPS 地址，请重新选择对应资源')
  }
  if (bytes > 50 * 1024 * 1024) throw new Error('图片总量超过 50 MiB 上限')
  const text = document.body.textContent || ''
  const imageCount = document.body.querySelectorAll('img').length
  if (!text.trim() && !imageCount) throw new Error('没有可以上传的正文')
  return {
    html: document.body.innerHTML, text,
    codes: [...document.body.querySelectorAll('pre')].map(el => el.textContent || ''),
    links: [...new Set([...document.body.querySelectorAll('a[href]')].map(el => el.getAttribute('href')!))],
    imageCount,
  }
}

const record = (value: unknown): Record<string, any> => value && typeof value === 'object' ? value as Record<string, any> : {}
const compact = (value: string) => value.replace(/\s+/g, '')
const codeText = (value: string) => value.replace(/\r\n/g, '\n').replace(/\n+$/, '')

function readText(data: any): { text: string; links: string[] } {
  const textData = record(data.text ?? data)
  const attributed = record(textData.initialAttributedTexts)
  const lines = typeof attributed.text === 'string' ? [attributed.text] : Object.keys(record(attributed.text)).sort((a, b) => Number(a) - Number(b)).map(key => String(attributed.text[key]))
  const attrs = typeof attributed.attribs === 'string' ? [attributed.attribs] : Object.values(record(attributed.attribs)).map(String)
  const pool = record(textData.apool?.numToAttrib)
  const active = new Set(attrs.flatMap(value => [...value.matchAll(/\*([0-9a-z]+)/g)].map(match => String(parseInt(match[1], 36)))))
  const links: string[] = []
  for (const id of active) {
    const pair = pool[id]
    if (!Array.isArray(pair) || !/(link|href|url|inline.component)/i.test(String(pair[0])) || /[-_]id$/i.test(pair[0])) continue
    let value = String(pair[1])
    try { value = decodeURIComponent(value) } catch { /* literal URL */ }
    links.push(...(value.match(/(?:https?:\/\/|mailto:|tel:)[^\s"<>]+/g) ?? []))
  }
  return { text: lines.join('\n'), links }
}

/** Read server block data, not page DOM. Unknown/partial response cannot certify a save. */
export function verifyFeishuSaved(data: unknown, expected: PreparedContent): { ok: boolean; reason: string } {
  const response = record(data)
  if (response.has_more || (Array.isArray(response.skip_blocks) && response.skip_blocks.length)) return { ok: false, reason: '服务端块树尚未完整读取' }
  const map = record(response.block_map)
  if (!Object.keys(map).length) return { ok: false, reason: '服务端没有返回正文块' }
  const root = Object.keys(map).find(id => (map[id].data?.type ?? map[id].type) === 'page')
  if (!root) return { ok: false, reason: '服务端块树缺少文档根节点' }
  const children = (entry: any): string[] => {
    const raw = entry?.children ?? entry?.data?.children
    return Array.isArray(raw) ? raw.map(String) : Object.values(record(raw)).flatMap(value => Array.isArray(value) ? value.map(String) : [])
  }
  const seen = new Set<string>(), ordered: any[] = []
  const visit = (id: string) => {
    if (seen.has(id) || !map[id]) return
    seen.add(id)
    ordered.push(map[id])
    for (const child of children(map[id])) visit(child)
  }
  if (root) visit(root)
  for (const id of Array.isArray(response.block_sequence) ? response.block_sequence : Object.keys(map)) visit(String(id))
  const texts: string[] = [], codes: string[] = [], links = new Set<string>()
  let images = 0
  for (const entry of ordered) {
    const block = record(entry.data ?? entry), type = String(block.type ?? entry.type ?? '')
    if (type === 'page') continue
    const read = readText(block)
    if (read.text) texts.push(read.text)
    read.links.forEach(link => links.add(link))
    if (type === 'code') codes.push(read.text)
    if (type === 'image' && typeof block.image?.token === 'string' && block.image.token) images++
  }
  if (compact(texts.join('')) !== compact(expected.text)) return { ok: false, reason: '正文与服务端保存的内容不一致' }
  const remainingCodes = [...codes]
  for (const expectedCode of expected.codes) {
    const index = remainingCodes.findIndex(code => codeText(code) === codeText(expectedCode))
    if (index < 0) return { ok: false, reason: '代码未保存为代码块或代码内容发生变化' }
    remainingCodes.splice(index, 1)
  }
  if (images !== expected.imageCount) return { ok: false, reason: '图片数量不一致或尚未保存为飞书图片资源' }
  if (expected.links.some(link => !links.has(link))) return { ok: false, reason: '网站链接未保存为可点击链接' }
  return { ok: true, reason: '正文、代码块、图片资源与链接已通过服务端回读验证' }
}
