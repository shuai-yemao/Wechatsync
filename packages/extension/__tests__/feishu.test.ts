import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createdDocument, feishuDocumentOrigin, feishuOrigin, prepareFeishuHtml, verifyFeishuSaved } from '../src/lib/feishu/protocol'
import { createFeishuDocument, pasteAndVerifyFeishu, selectFeishuTab } from '../src/lib/feishu/browser'
import { FeishuAdapter } from '../src/adapters/feishu'

const origin = 'https://test.feishu.cn'
const token = 'NewDocToken123'
const created = { code: 0, data: { node_list: ['node'], entities: { nodes: { node: { obj_token: token, url: `${origin}/docx/${token}` } } } } }
const attributed = (text: string) => ({ initialAttributedTexts: { text: { '0': text }, attribs: { '0': '*0+5' } }, apool: { numToAttrib: { '0': ['link', 'https://example.com'] } } })
const saved = () => ({ block_map: {
  root: { data: { type: 'page' }, children: ['text', 'code', 'image'] },
  text: { data: { type: 'text', text: attributed('网站') } },
  code: { data: { type: 'code', text: attributed('if (x < 2) {\n  return x;\n}') } },
  image: { data: { type: 'image', image: { token: 'remote-media-token' } } },
} })
const html = '<p><a href="https://example.com">网站</a></p><pre><code class="language-c">if (x &lt; 2) {\n  return x;\n}</code></pre><img src="data:image/png;base64,iVBORw==">'

beforeEach(() => {
  Object.assign(chrome, {
    permissions: { contains: vi.fn(async () => true) },
    cookies: { get: vi.fn(async () => ({ value: 'csrf-value' })), getAll: vi.fn(async () => [{ name: 'session', value: 'session-value' }]) },
    scripting: { executeScript: vi.fn(async () => [{ result: { ok: true, value: created } }]) },
    debugger: { attach: vi.fn(async () => { throw new Error('浏览器正在被其他调试器使用') }), detach: vi.fn(async () => {}), sendCommand: vi.fn() },
  })
  vi.mocked(chrome.tabs.query).mockResolvedValue([{ id: 1, url: origin + '/drive/home/', active: true }] as chrome.tabs.Tab[])
  vi.mocked(chrome.tabs.create).mockResolvedValue({ id: 2 } as chrome.tabs.Tab)
})

describe('Feishu content and remote verification', () => {
  it('retains literal code, clickable links and inline images after cleaning', () => {
    const prepared = prepareFeishuHtml(html + '<script>bad()</script><p onclick="bad()">正文</p>')
    expect(prepared.html).not.toMatch(/script|onclick/)
    expect(prepared.codes).toEqual(['if (x < 2) {\n  return x;\n}'])
    expect(prepared.links).toEqual(['https://example.com'])
    expect(prepared.imageCount).toBe(1)
  })
  it('requires server text, actual code blocks, media tokens and attributed links', () => {
    const expected = prepareFeishuHtml(html)
    expect(verifyFeishuSaved(saved(), expected).ok).toBe(true)
    const codeWrong = saved(); codeWrong.block_map.code.data.type = 'text'
    expect(verifyFeishuSaved(codeWrong, expected).reason).toContain('代码')
    const noImage = saved(); noImage.block_map.image.data.image.token = ''
    expect(verifyFeishuSaved(noImage, expected).reason).toContain('图片')
    const noLink = saved(); noLink.block_map.text.data.text.initialAttributedTexts.attribs['0'] = '+2'
    noLink.block_map.code.data.text.initialAttributedTexts.attribs['0'] = '+1'
    expect(verifyFeishuSaved(noLink, expected).reason).toContain('链接')
  })
  it('rejects missing, partial, unknown and blank remote content', () => {
    const expected = prepareFeishuHtml(html)
    expect(verifyFeishuSaved({}, expected).ok).toBe(false)
    expect(verifyFeishuSaved({ ...saved(), has_more: true }, expected).ok).toBe(false)
    expect(verifyFeishuSaved({ ...saved(), skip_blocks: ['table'] }, expected).ok).toBe(false)
    const data = saved(); delete (data.block_map as any).root
    expect(verifyFeishuSaved(data, expected).ok).toBe(false)
    expect(verifyFeishuSaved({ block_map: { root: { data: { type: 'page' } } } }, expected).ok).toBe(false)
  })
  it('rejects dangerous image addresses, oversize and empty documents before creation', () => {
    expect(() => prepareFeishuHtml('<img src="file:///secret.png">')).toThrow('图片')
    expect(() => prepareFeishuHtml('<img src="data:image/svg+xml;base64,PHN2Zz4=">')).toThrow('图片')
    expect(() => prepareFeishuHtml('<p>' + 'x'.repeat(6 * 1024 * 1024) + '</p>')).toThrow('5 MiB')
    expect(() => prepareFeishuHtml('<script>bad()</script>')).toThrow('正文')
  })
})

describe('Feishu script injection boundary', () => {
  async function clipboardScript(loading = false, minimized = false) {
    let script: any
    vi.mocked(chrome.debugger.attach).mockResolvedValue(undefined)
    Object.assign(chrome.tabs, { update: vi.fn(async () => ({})), get: vi.fn(async () => ({ status: loading ? 'loading' : 'complete', url: `${origin}/docx/${token}`, ...(minimized ? { windowId: 7 } : {}) })) })
    if (minimized) Object.assign(chrome, { windows: { get: vi.fn(async () => ({ state: 'minimized' })), update: vi.fn(async () => ({})) } })
    vi.mocked(chrome.scripting.executeScript).mockImplementation(async injection => {
      if (String(injection.args?.[1]).includes('client_vars')) return [{ frameId: 0, result: { ok: true, value: { data: { block_map: { root: { data: { type: 'page' }, children: ['blank'] }, blank: { data: { type: 'text' } } } } } } }]
      if (injection.args?.length === 3) return [{ frameId: 0, result: { x: 1, y: 1 } }]
      if (injection.args?.length === 4) { script = injection.func; return [{ frameId: 0, result: { ok: false, error: '备份剪贴板失败：Document is not focused' } }] }
      return [{ frameId: 0, result: true }]
    })
    await expect(pasteAndVerifyFeishu(2, origin, token, prepareFeishuHtml('<p>正文</p>'))).rejects.toThrow('Document is not focused')
    expect(chrome.debugger.detach).toHaveBeenCalled()
    return script
  }

  it('returns the clipboard rejection as diagnostic data without losing its cause', async () => {
    const script = await clipboardScript()
    const read = vi.fn(async () => { throw new Error('clipboard unavailable') })
    vi.stubGlobal('location', { origin, pathname: `/docx/${token}` })
    vi.stubGlobal('navigator', { clipboard: { read } })
    try {
      expect(await script(origin, `/docx/${token}`, '<p>正文</p>', '正文')).toEqual({ ok: false, error: '备份剪贴板失败：clipboard unavailable' })
      expect(read).toHaveBeenCalledTimes(1)
    } finally { vi.unstubAllGlobals() }
  })

  it('bounds retries for transient focus denial before any clipboard write', async () => {
    const script = await clipboardScript()
    const read = vi.fn(async () => { throw Object.assign(new Error('Document is not focused'), { name: 'NotAllowedError' }) })
    vi.stubGlobal('location', { origin, pathname: `/docx/${token}` })
    vi.stubGlobal('navigator', { clipboard: { read } })
    vi.useFakeTimers()
    try {
      const pending = script(origin, `/docx/${token}`, '<p>正文</p>', '正文')
      await vi.runAllTimersAsync()
      expect((await pending).error).toContain('Document is not focused')
      expect(read).toHaveBeenCalledTimes(4)
    } finally { vi.useRealTimers(); vi.unstubAllGlobals() }
  })

  it('does not write or retry when clipboard formats cannot be restored', async () => {
    const script = await clipboardScript()
    const getType = vi.fn()
    vi.stubGlobal('location', { origin, pathname: `/docx/${token}` })
    vi.stubGlobal('navigator', { clipboard: { read: vi.fn(async () => [{ types: ['application/custom'], getType }]) } })
    try {
      expect((await script(origin, `/docx/${token}`, '<p>正文</p>', '正文')).error).toContain('无法恢复')
      expect(getType).not.toHaveBeenCalled()
    } finally { vi.unstubAllGlobals() }
  })

  it('uses editor readiness even when background resources keep the tab loading', async () => {
    await clipboardScript(true)
    const ready = vi.mocked(chrome.scripting.executeScript).mock.calls.find(([injection]) => injection.injectImmediately)
    expect(ready).toBeDefined()
    expect(chrome.tabs.get).toHaveBeenCalledTimes(3)
  })

  it('restores a minimized target window before accessing its editor and clipboard', async () => {
    await clipboardScript(false, true)
    expect(chrome.windows.update).toHaveBeenCalledWith(7, { state: 'normal', focused: true })
    expect(chrome.tabs.update).toHaveBeenCalledWith(2, { active: true })
  })

  it('writes HTML once and re-reads an expired clipboard snapshot without another write', async () => {
    const script = await clipboardScript()
    const read = vi.fn()
      .mockResolvedValueOnce([{ types: ['text/plain'], getType: async () => new Blob(['original'], { type: 'text/plain' }) }])
      .mockResolvedValueOnce([{ types: ['text/html'], getType: async () => { throw new Error('Clipboard data has changed') } }])
      .mockResolvedValueOnce([{ types: ['text/html'], getType: async () => new Blob(['<p>正文</p>'], { type: 'text/html' }) }])
    const write = vi.fn(async () => {})
    vi.stubGlobal('location', { origin, pathname: `/docx/${token}` })
    vi.stubGlobal('navigator', { clipboard: { read, write } })
    vi.stubGlobal('ClipboardItem', class { constructor(public data: Record<string, Blob>) {} })
    vi.useFakeTimers()
    try {
      const pending = script(origin, `/docx/${token}`, '<p>正文</p>', '正文')
      await vi.runAllTimersAsync()
      expect(await pending).toEqual({ ok: true, html: '<p>正文</p>' })
      expect(write).toHaveBeenCalledTimes(1)
      expect(read).toHaveBeenCalledTimes(3)
      expect((globalThis as any).__wechatsyncFeishuClipboard[0]['text/plain']).toBeInstanceOf(Blob)
    } finally { delete (globalThis as any).__wechatsyncFeishuClipboard; vi.useRealTimers(); vi.unstubAllGlobals() }
  })

  it('never passes undefined through Chrome args when reading a saved document', async () => {
    vi.mocked(chrome.debugger.attach).mockResolvedValue(undefined)
    Object.assign(chrome.tabs, { update: vi.fn(async () => ({})), get: vi.fn(async () => ({ status: 'complete', url: `${origin}/docx/${token}` })) })
    let readArgs: unknown[] | undefined
    vi.mocked(chrome.scripting.executeScript).mockImplementation(async injection => {
      if (String(injection.args?.[1]).includes('client_vars')) {
        readArgs = injection.args
        if (injection.args?.some(value => value === undefined)) throw new Error('Value is unserializable')
        return [{ result: { ok: true, value: { code: 0, data: {} } }, frameId: 0 }]
      }
      return [{ result: true, frameId: 0 }]
    })
    await expect(pasteAndVerifyFeishu(2, origin, token, prepareFeishuHtml('<p>正文</p>'))).rejects.toThrow('没有正文块树')
    expect(readArgs).toBeDefined()
    expect(readArgs).not.toContain(undefined)
    expect(chrome.debugger.detach).toHaveBeenCalledWith({ tabId: 2 })
  })

  it('preserves HTTP diagnostics returned by the page instead of losing the reason', async () => {
    vi.mocked(chrome.scripting.executeScript).mockResolvedValue([{ frameId: 0, result: { ok: false, error: '飞书请求失败 HTTP 403', csrfRejected: false } }])
    await expect(createFeishuDocument(1, origin, '测试')).rejects.toThrow('HTTP 403')
  })

  it('tries the second CSRF cookie only after an explicit CSRF rejection', async () => {
    vi.mocked(chrome.cookies.get).mockImplementation(async ({ name }) => ({ value: name === '_csrf_token' ? 'stale' : 'valid' }) as chrome.cookies.Cookie)
    vi.mocked(chrome.scripting.executeScript)
      .mockResolvedValueOnce([{ frameId: 0, result: { ok: false, error: '飞书请求失败 HTTP 403（CSRF 校验失败）', csrfRejected: true } }])
      .mockResolvedValueOnce([{ frameId: 0, result: { ok: true, value: created } }])
    expect(await createFeishuDocument(1, origin, '测试')).toEqual({ token, url: `${origin}/docx/${token}` })
    const calls = vi.mocked(chrome.scripting.executeScript).mock.calls
    expect(calls[0][0].args?.[2]).toBe('stale')
    expect(calls[1][0].args?.[2]).toBe('valid')
  })

  it('does not retry document creation after network errors', async () => {
    vi.mocked(chrome.scripting.executeScript).mockResolvedValue([{ frameId: 0, result: { ok: false, error: 'Failed to fetch', csrfRejected: false } }])
    await expect(createFeishuDocument(1, origin, '测试')).rejects.toThrow('Failed to fetch')
    expect(chrome.scripting.executeScript).toHaveBeenCalledTimes(1)
  })
})

describe('Feishu tenant and create boundaries', () => {
  it('accepts only HTTPS Feishu/Lark tenants, excluding credential/port/lookalike URLs', () => {
    expect(feishuOrigin(origin)).toBe(origin)
    for (const url of ['http://test.feishu.cn', 'https://feishu.cn.evil.test', 'https://user@test.feishu.cn', 'https://test.feishu.cn:8443', 'https://accounts.feishu.cn']) expect(feishuOrigin(url)).toBeNull()
  })
  it('validates returned document token and current tenant URL', () => {
    expect(createdDocument(created, origin)).toEqual({ token, url: `${origin}/docx/${token}` })
    expect(() => createdDocument({ code: 1 }, origin)).toThrow('创建失败')
    const other = structuredClone(created); other.data.entities.nodes.node.url = 'https://evil.test/docx/' + token
    expect(() => createdDocument(other, origin)).toThrow('当前租户')
  })
  it('rejects recruitment, marketing and login pages as document destinations', () => {
    for (const url of ['https://agirobot.jobs.feishu.cn/campusrecruitment/position/123/detail', 'https://jobs.feishu.cn/drive/home/', 'https://www.feishu.cn/product/docs', 'https://accounts.feishu.cn/docx/SomeToken', origin, origin + '/campusrecruitment/']) expect(feishuDocumentOrigin(url)).toBeNull()
    for (const path of ['/drive/home/', '/docx/SomeToken', '/docs/SomeToken', '/wiki/SomeToken', '/sheets/SomeToken']) expect(feishuDocumentOrigin(origin + path)).toBe(origin)
    expect(feishuDocumentOrigin('https://test.larksuite.com/drive/home/')).toBe('https://test.larksuite.com')
  })
  it('ignores the active recruitment tab and selects an actual cloud document', async () => {
    vi.mocked(chrome.tabs.query).mockResolvedValue([{ id: 1, url: 'https://agirobot.jobs.feishu.cn/campusrecruitment/position/123/detail', active: true }, { id: 2, url: origin + '/drive/home/', active: false }] as chrome.tabs.Tab[])
    expect(await selectFeishuTab()).toEqual({ tabId: 2, origin })
  })
  it('does not report cloud document authentication or create when only a recruitment page is open', async () => {
    vi.mocked(chrome.tabs.query).mockResolvedValue([{ id: 1, url: 'https://agirobot.jobs.feishu.cn/campusrecruitment/position/123/detail', active: true }] as chrome.tabs.Tab[])
    expect((await new FeishuAdapter().checkAuth()).isAuthenticated).toBe(false)
    expect((await new FeishuAdapter().publish({ title: '测试', markdown: '正文' })).success).toBe(false)
    expect(chrome.cookies.getAll).not.toHaveBeenCalled()
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled()
    expect(chrome.tabs.create).not.toHaveBeenCalled()
  })
  it('requires an unambiguous selected tenant', async () => {
    vi.mocked(chrome.tabs.query).mockResolvedValue([{ id: 1, url: origin + '/drive/home/' }, { id: 2, url: 'https://other.feishu.cn/docx/SomeToken' }] as chrome.tabs.Tab[])
    await expect(selectFeishuTab()).rejects.toThrow('多个')
    vi.mocked(chrome.tabs.query).mockResolvedValue([])
    await expect(selectFeishuTab()).rejects.toThrow('登录')
  })
  it('does not create documents when permission is denied', async () => {
    vi.mocked(chrome.permissions.contains).mockResolvedValue(false)
    const result = await new FeishuAdapter().publish({ title: '测试', markdown: '正文' })
    expect(result.success).toBe(false)
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled()
    expect(chrome.tabs.create).not.toHaveBeenCalled()
  })
  it('retains the created URL on editor failure without a second create attempt', async () => {
    const result = await new FeishuAdapter().publish({ title: '测试', markdown: '正文' })
    expect(result.success).toBe(false)
    expect(result.postUrl).toBe(`${origin}/docx/${token}`)
    expect(result.error).toContain('其他调试器')
    expect(chrome.scripting.executeScript).toHaveBeenCalledTimes(1)
    expect(chrome.tabs.create).toHaveBeenCalledTimes(1)
    expect(chrome.debugger.detach).not.toHaveBeenCalled()
  })
  it('cleans up its debugger attachment when editor preparation fails', async () => {
    vi.mocked(chrome.debugger.attach).mockResolvedValue(undefined)
    vi.mocked(chrome.debugger.sendCommand).mockRejectedValue(new Error('编辑器准备失败'))
    const result = await new FeishuAdapter().publish({ title: '测试', markdown: '正文' })
    expect(result.success).toBe(false)
    expect(chrome.debugger.detach).toHaveBeenCalledWith({ tabId: 2 })
    expect(result.postUrl).toBe(`${origin}/docx/${token}`)
  })
})
