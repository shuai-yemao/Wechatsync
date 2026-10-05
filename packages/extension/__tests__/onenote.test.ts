import { beforeEach, describe, expect, it, vi } from 'vitest'
import { authorizeOneNote, disconnectOneNote } from '../src/lib/onenote/auth'
import { matchesOneNotePage, oneNotePageGuid, readOneNotePage, validateOneNoteSource } from '../src/lib/onenote/reader'
import { prepareOneNoteImport } from '../src/lib/onenote'
import { parseHTML } from 'linkedom'

const GUID = '12345678-1234-1234-1234-123456789abc'
const LINK = `https://www.onenote.com/notebooks/page#page-id=%7B${GUID}%7D`
const CLIENT_ID = '00000000-1111-2222-3333-444444444444'
const GRAPH = 'https://graph.microsoft.com/v1.0/me/onenote'
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })
const metadata = { id: 'graph-id-not-guid', title: '笔记', links: { oneNoteWebUrl: { href: LINK } } }

beforeEach(() => vi.unstubAllGlobals())

describe('OneNote link resolution', () => {
  it('matches encoded page GUID against metadata, but never title or Graph id', () => {
    const deep = `onenote:https://example.sharepoint.com/a.one#测试&page-id={${GUID.toUpperCase()}}`
    expect(oneNotePageGuid(deep)).toBe(GUID)
    expect(matchesOneNotePage(deep, metadata)).toBe(true)
    expect(matchesOneNotePage(LINK, { id: GUID, title: '笔记' })).toBe(false)
    expect(matchesOneNotePage('https://www.onenote.com/notebooks/笔记', metadata)).toBe(false)
  })

  it('rejects arbitrary hosts, credentials, JavaScript, short links, and notebook-only deep links', () => {
    for (const source of ['javascript:alert(1)', 'https://evil.test/page', 'https://user@www.onenote.com/page', 'https://1drv.ms/u/id', 'onenote:C:\\local.one']) {
      expect(() => validateOneNoteSource(source)).toThrow()
    }
    expect(() => validateOneNoteSource(`onenote:C:\\local.one#page-id={${GUID}}`)).not.toThrow()
  })
})

describe('OneNote Graph reader', () => {
  it('prepares preview Markdown with links, images, and code indentation', () => {
    vi.stubGlobal('document', parseHTML('<html><body></body></html>').document)
    const result = prepareOneNoteImport({ title: '测试', sourceUrl: LINK, warnings: [],
      html: '<h2>标题</h2><p><a href="https://example.com">网站</a></p><pre><code>if (x &lt; 2) {\n  return x;\n}</code></pre><img src="data:image/png;base64,iVBORw==" alt="测试">' })
    expect(result.markdown).toContain('## 标题')
    expect(result.markdown).toContain('[网站](https://example.com)')
    expect(result.markdown).toContain('  return x;')
    expect(result.markdown).toContain('data:image/png;base64,iVBORw==')
  })

  it('follows pagination, uses actual Graph id, sanitizes active HTML, and embeds protected images', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json({ value: [], '@odata.nextLink': `${GRAPH}/pages?$skip=100` }))
      .mockResolvedValueOnce(json({ value: [metadata] }))
      .mockResolvedValueOnce(new Response('<html><body><h2 onclick="steal()">标题</h2><script>bad()</script><p>正文<a href="javascript:bad()">危险链接</a></p><pre><code>if (x &lt; 2) {\n  return x;\n}</code></pre><img src="https://graph.microsoft.com/v1.0/me/onenote/resources/image/$value" onerror="bad()"><object data="file.pdf"></object></body></html>'))
      .mockResolvedValueOnce(new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'Content-Type': 'image/png' } }))
    vi.stubGlobal('fetch', fetcher)
    const result = await readOneNotePage(LINK, 'private-token')
    expect(fetcher.mock.calls[2][0]).toBe(`${GRAPH}/pages/graph-id-not-guid/content`)
    expect(fetcher.mock.calls[3][1].headers.Authorization).toBe('Bearer private-token')
    expect(result.html).toContain('data:image/png;base64,iVBORw==')
    expect(result.html).toContain('  return x;')
    expect(result.html).not.toMatch(/script|onclick|onerror|javascript:|object|private-token/)
    expect(result.warnings).toContain('OneNote 附件、音视频、墨迹或绘图暂不导入；请在来源笔记中查看。')
  })

  it('never sends access token to external images or malicious pagination', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json({ value: [metadata] }))
      .mockResolvedValueOnce(new Response('<html><body><img src="https://images.example/p.png"></body></html>'))
    vi.stubGlobal('fetch', fetcher)
    const result = await readOneNotePage(LINK, 'private-token')
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(result.html).toContain('https://images.example/p.png')
    fetcher.mockReset().mockResolvedValueOnce(json({ value: [], '@odata.nextLink': 'https://evil.test/leak' }))
    await expect(readOneNotePage(LINK, 'private-token')).rejects.toThrow('不可信')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('maps legacy OneNote resource URI to Graph without trusting arbitrary OneNote endpoints', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json({ value: [metadata] }))
      .mockResolvedValueOnce(new Response('<html><body><img src="https://www.onenote.com/api/v1.0/me/notes/resources/image-id/$value"></body></html>'))
      .mockResolvedValueOnce(new Response(new Uint8Array([1]), { headers: { 'Content-Type': 'image/jpeg' } }))
    vi.stubGlobal('fetch', fetcher)
    await readOneNotePage(LINK, 'private-token')
    expect(fetcher.mock.calls[2][0]).toBe(`${GRAPH}/resources/image-id/$value`)
  })

  it('reports inaccessible/missing pages instead of returning empty imported content', async () => {
    const fetcher = vi.fn().mockResolvedValue(json({ value: [] }))
    vi.stubGlobal('fetch', fetcher)
    await expect(readOneNotePage(LINK, 'token')).rejects.toThrow('未能')
    fetcher.mockResolvedValue(new Response('', { status: 403 }))
    await expect(readOneNotePage(LINK, 'token')).rejects.toThrow('无权')
    fetcher.mockResolvedValue(new Response('', { status: 401 }))
    await expect(readOneNotePage(LINK, 'token')).rejects.toThrow('失效')
  })

  it('rejects oversize HTML before decoding and unsafe image types', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json({ value: [metadata] }))
      .mockResolvedValueOnce(new Response('', { headers: { 'Content-Length': `${6 * 1024 * 1024}` } }))
    vi.stubGlobal('fetch', fetcher)
    await expect(readOneNotePage(LINK, 'token')).rejects.toThrow('大小限制')
    fetcher.mockReset().mockResolvedValueOnce(json({ value: [metadata] }))
      .mockResolvedValueOnce(new Response('<html><body><img src="https://graph.microsoft.com/v1.0/me/onenote/resources/image/$value"></body></html>'))
      .mockResolvedValueOnce(new Response('<svg/>', { headers: { 'Content-Type': 'image/svg+xml' } }))
    await expect(readOneNotePage(LINK, 'token')).rejects.toThrow('不安全')
  })
})

describe('OneNote browser OAuth', () => {
  function browser(callback?: (authorize: URL) => string) {
    const cache: Record<string, unknown> = {}
    const session = { get: vi.fn(async () => cache), set: vi.fn(async (data: object) => Object.assign(cache, data)),
      remove: vi.fn(async (key: string) => { delete cache[key] }) }
    const identity = { getRedirectURL: vi.fn(() => 'https://extension.chromiumapp.org/onenote'),
      launchWebAuthFlow: vi.fn(async ({ url }: { url: string }) => {
        const authorize = new URL(url)
        return callback ? callback(authorize) : `https://extension.chromiumapp.org/onenote?code=secret-code&state=${authorize.searchParams.get('state')}`
      }) }
    vi.stubGlobal('chrome', { identity, storage: { session } })
    return { cache, session, identity }
  }

  it('uses PKCE and least permission, stores only expiring session token, and can disconnect', async () => {
    const { identity, session } = browser()
    const fetcher = vi.fn().mockResolvedValue(json({ access_token: 'private-token', expires_in: 3600, token_type: 'Bearer' }))
    vi.stubGlobal('fetch', fetcher)
    expect(await authorizeOneNote(CLIENT_ID)).toBe('private-token')
    const authorize = new URL(identity.launchWebAuthFlow.mock.calls[0][0].url)
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256')
    expect(authorize.searchParams.get('scope')).toBe('https://graph.microsoft.com/Notes.Read')
    expect(authorize.searchParams.has('client_secret')).toBe(false)
    const body = fetcher.mock.calls[0][1].body as URLSearchParams
    expect(body.get('code_verifier')).toHaveLength(43)
    expect(body.has('client_secret')).toBe(false)
    expect(session.set).toHaveBeenCalledTimes(1)
    expect(await authorizeOneNote(CLIENT_ID)).toBe('private-token')
    expect(identity.launchWebAuthFlow).toHaveBeenCalledTimes(1)
    await disconnectOneNote()
    expect(session.remove).toHaveBeenCalled()
  })

  it('rejects wrong state/redirect before exchanging authorization code', async () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    browser(() => 'https://evil.test/onenote?code=secret&state=wrong')
    await expect(authorizeOneNote(CLIENT_ID)).rejects.toThrow('校验失败')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('requires public application configuration before launching login', async () => {
    const { identity } = browser()
    await expect(authorizeOneNote('')).rejects.toThrow('client ID')
    expect(identity.launchWebAuthFlow).not.toHaveBeenCalled()
  })
})
