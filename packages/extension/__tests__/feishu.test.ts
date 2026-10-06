import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createdDocument, feishuOrigin, prepareFeishuHtml, verifyFeishuSaved } from '../src/lib/feishu/protocol'
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
  it('requires an unambiguous selected tenant', async () => {
    vi.mocked(chrome.tabs.query).mockResolvedValue([{ id: 1, url: origin }, { id: 2, url: 'https://other.feishu.cn' }] as chrome.tabs.Tab[])
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
