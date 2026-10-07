import { afterEach, describe, expect, it, vi } from 'vitest'
import { draftFiles, publish, readAgentIndex, repositoryName, testConnection } from '../src/adapters/cms/powernotes'

const credentials = { username: 'user/power-notes', url: 'https://user.github.io/power-notes/', password: 'private-test-token' }
const empty = '/* generated */\nwindow.POWER_AGENT_NOTES = [];\nwindow.POWER_NOTES.push(...window.POWER_AGENT_NOTES);\n'
const encode = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)))
afterEach(() => vi.unstubAllGlobals())

function github(options: { write?: boolean; truncated?: boolean; index?: string; lostRefResponse?: boolean; existingFile?: boolean; wrongReadback?: boolean; existingSlug?: string } = {}) {
  let createdRef = false
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input), body = init?.body ? JSON.parse(String(init.body)) : undefined
    let result: any = {}
    if (url.endsWith('/user/power-notes')) result = { permissions: { push: options.write !== false }, default_branch: 'main' }
    else if (url.endsWith('/git/ref/heads/main')) result = { object: { sha: 'parent' } }
    else if (url.endsWith('/git/commits/parent')) result = { tree: { sha: 'base-tree' } }
    else if (url.includes('/git/trees/base-tree?')) result = { truncated: options.truncated || false, tree: [
      { path: 'agent-notes.js', type: 'blob', mode: '100644', sha: 'index' }, { path: 'taxonomy.js', type: 'blob' },
      ...(options.existingFile ? [{ path: 'notes/agent-imports/example.md', type: 'blob' }] : []),
      ...(options.existingSlug ? [{ path: 'notes.js', type: 'blob', mode: '100644', sha: 'existing-notes' }] : []),
    ] }
    else if (url.endsWith('/git/blobs/index')) result = { encoding: 'base64', content: encode(options.index || empty) }
    else if (url.endsWith('/git/blobs/existing-notes')) result = { encoding: 'base64', content: encode(`window.POWER_NOTES = [{slug: '${options.existingSlug}'}];`) }
    else if (url.endsWith('/git/blobs')) result = { sha: 'blob-' + fetcher.mock.calls.length }
    else if (url.endsWith('/git/trees')) result = { sha: 'draft-tree' }
    else if (url.endsWith('/git/commits')) result = { sha: 'draft-commit' }
    else if (url.endsWith('/git/refs')) {
      createdRef = true
      if (options.lostRefResponse) throw new Error('Network response lost')
      result = { ref: body.ref }
    } else if (url.includes('/git/ref/heads/codex')) result = { object: { sha: options.wrongReadback ? 'other' : 'draft-commit' } }
    else throw new Error('Unexpected test request: ' + url)
    return new Response(JSON.stringify(result), { status: 200 })
  })
  vi.stubGlobal('fetch', fetcher)
  return { fetcher, createdRef: () => createdRef }
}

describe('Power Notes draft package', () => {
  it('validates repository names before sending a credential', () => {
    expect(repositoryName('user/power-notes')).toBe('user/power-notes')
    for (const value of ['https://evil.test', '../repo', 'user/..', 'user/repo?token=secret', 'user/repo/../other']) expect(() => repositoryName(value)).toThrow()
  })

  it('parses generated index data without executing repository JavaScript', () => {
    expect(readAgentIndex(empty)).toEqual([])
    expect(() => readAgentIndex(empty + 'globalThis.executed = true;')).toThrow()
    expect(() => readAgentIndex(empty.replace('[]', '[{slug:"x"}]'))).toThrow()
  })

  it('keeps code and links, relocates actual local images and preserves existing index entries', async () => {
    const input = '# 标题\n\n[网站](https://example.com)\n\n```html\n<img src="example.png">\n![example](example.png)\n```\n\n![配图](<data:image/png;base64,aGVsbG8=>)'
    const result = await draftFiles('中文标题', input, 'embedded', [{ slug: 'old', file: 'notes/old.md', title: '旧文章' }])
    const markdown = result.files.find(file => file.path.endsWith('.md'))!.content
    expect(markdown).toContain('[网站](https://example.com)')
    expect(markdown).toContain('<img src="example.png">\n![example](example.png)')
    expect(markdown).toContain(`![配图](assets/${result.slug}/image-1.png)`)
    expect(result.files.filter(file => file.encoding === 'base64')).toHaveLength(1)
    const notes = readAgentIndex(result.files.find(file => file.path === 'agent-notes.js')!.content)
    expect(notes).toHaveLength(2)
    expect(notes[0].title).toBe('旧文章')
    expect(notes[1].categoryPath).toEqual(['embedded'])
  })

  it('uses reference images without changing their code examples', async () => {
    const result = await draftFiles('reference', '![图片][pic]\n\n[pic]: data:image/png;base64,aGVsbG8=')
    expect(result.files.filter(file => file.encoding === 'base64')).toHaveLength(1)
    expect(result.files.find(file => file.path.endsWith('.md'))!.content).toContain('assets/reference/image-1.png')
  })

  it('rejects missing local images, unknown categories and duplicate titles', async () => {
    await expect(draftFiles('title', '![图片](missing.png)')).rejects.toThrow('本地导入')
    await expect(draftFiles('title', '正文', 'unknown')).rejects.toThrow('分类')
    await expect(draftFiles('Example', '正文', 'tools', [{ slug: 'example' }])).rejects.toThrow('同名')
    await expect(draftFiles('title', '<img src="data:image/png;base64,aGVsbG8=">')).rejects.toThrow('HTML 图片')
  })
})

describe('GitHub browser boundary and draft writes', () => {
  it('checks a real repository snapshot using only read requests and a fixed API host', async () => {
    const { fetcher } = github()
    expect(await testConnection(credentials)).toEqual({ success: true })
    for (const [url, init] of fetcher.mock.calls) {
      expect(String(url)).toMatch(/^https:\/\/api\.github\.com\/repos\/user\/power-notes/)
      expect(init?.method).toBe('GET')
      expect(init?.redirect).toBe('error')
    }
  })

  it('does not write when permissions or a complete snapshot are unavailable', async () => {
    let mocked = github({ write: false })
    expect((await publish(credentials, { title: 'Example', markdown: '正文' })).success).toBe(false)
    expect(mocked.fetcher.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
    mocked = github({ truncated: true })
    expect((await publish(credentials, { title: 'Example', markdown: '正文' })).error).toContain('完整读取')
    expect(mocked.fetcher.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
  })

  it('refuses to overwrite an existing Markdown or legacy note slug', async () => {
    for (const options of [{ existingFile: true }, { existingSlug: 'example' }]) {
      const { fetcher } = github(options)
      expect((await publish(credentials, { title: 'Example', markdown: '正文' })).error).toContain('停止覆盖')
      expect(fetcher.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
    }
  })

  it('creates an atomic commit on a new draft branch and never updates the default branch', async () => {
    const { fetcher } = github()
    const result = await publish(credentials, { title: 'Example', markdown: '代码\n```c\nreturn 1;\n```' })
    expect(result.success).toBe(true)
    expect(result.postId).toMatch(/^codex\/wechatsync-/)
    const writes = fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')
    const tree = writes.find(([url]) => String(url).endsWith('/git/trees'))!
    expect(JSON.parse(String(tree[1]?.body)).base_tree).toBe('base-tree')
    const commit = writes.find(([url]) => String(url).endsWith('/git/commits'))!
    expect(JSON.parse(String(commit[1]?.body)).parents).toEqual(['parent'])
    const ref = writes.find(([url]) => String(url).endsWith('/git/refs'))!
    expect(JSON.parse(String(ref[1]?.body)).ref).toMatch(/^refs\/heads\/codex\/wechatsync-/)
    expect(fetcher.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false)
  })

  it('returns a review link on uncertain branch creation and failed readback', async () => {
    for (const options of [{ lostRefResponse: true }, { wrongReadback: true }]) {
      github(options)
      const result = await publish(credentials, { title: 'Example', markdown: '正文' })
      expect(result.success).toBe(false)
      expect(result.postUrl).toContain('/compare/')
      expect(result.error).toContain('避免重复上传')
    }
  })

  it('does not include a credential or server response body in diagnostics', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('private-test-token', { status: 401 })))
    const result = await testConnection(credentials)
    expect(result.error).toContain('HTTP 401')
    expect(JSON.stringify(result)).not.toContain(credentials.password)
  })
})
