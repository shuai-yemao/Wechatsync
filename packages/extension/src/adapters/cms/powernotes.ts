import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'

export interface PowerNotesCredentials {
  url: string
  username: string // owner/repository, never a URL
  password: string // GitHub token, only sent to api.github.com
  category?: string
}
const categories: Record<string, string> = { embedded: '嵌入式', software: '软件工程', tools: '工具与方法', thinking: '思考与随笔' }
type DraftFile = { path: string; content: string; encoding: 'utf-8' | 'base64' }

export function repositoryName(value: string): string {
  if (!/^[a-z0-9][a-z0-9-]*\/[a-z0-9_.-]+$/i.test(value) || value.split('/')[1] === '.' || value.split('/')[1] === '..') throw new Error('仓库请填写 owner/repository')
  return value
}

const byteLength = (value: string) => new TextEncoder().encode(value).length
const decode = (value: string) => new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(value.replace(/\s/g, '')), c => c.charCodeAt(0)))

/** Parse the generated data file, never execute repository JavaScript. */
export function readAgentIndex(source: string): any[] {
  if (byteLength(source) > 4 * 1024 * 1024) throw new Error('博客索引超过 4 MiB 上限')
  const match = source.replace(/^\uFEFF/, '').match(/^\s*(?:\/\*[\s\S]*?\*\/\s*)?window\.POWER_AGENT_NOTES\s*=\s*(\[[\s\S]*\])\s*;\s*window\.POWER_NOTES\.push\(\.\.\.window\.POWER_AGENT_NOTES\);\s*$/)
  if (!match) throw new Error('博客索引格式不兼容，停止写入')
  const notes = JSON.parse(match[1])
  if (!Array.isArray(notes) || notes.some(note => !note || typeof note.slug !== 'string' || typeof note.file !== 'string')) throw new Error('博客索引数据无效')
  return notes
}

export async function draftFiles(title: string, markdown: string, category = 'tools', existing: any[] = []): Promise<{ slug: string; files: DraftFile[] }> {
  if (!title.trim() || title.length > 240) throw new Error('文章标题不能为空且最多 240 字符')
  if (!markdown.trim() || byteLength(markdown) > 1024 * 1024) throw new Error('请提供不超过 1 MiB 的 Markdown 正文')
  if (!Object.hasOwn(categories, category)) throw new Error('未知博客分类')
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(title)))).map(n => n.toString(16).padStart(2, '0')).join('')
  const ascii = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  const slug = ascii ? ascii.slice(0, 72) : `note-${digest.slice(0, 12)}`
  if (existing.some(note => note.slug === slug)) throw new Error('同名笔记已存在，请修改标题或在博客仓库手动编辑')
  const file = `notes/agent-imports/${slug}.md`
  const files: DraftFile[] = []
  const replacements: { start: number; end: number; value: string }[] = []
  const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown)
  const images: any[] = []
  let htmlImage = false
  const definitions = new Map<string, string>()
  const walk = (node: any) => {
    if (node.type === 'image' || node.type === 'imageReference') images.push(node)
    if (node.type === 'definition') definitions.set(node.identifier, node.url)
    if (node.type === 'html' && /<img\b/i.test(node.value || '')) htmlImage = true
    node.children?.forEach(walk)
  }
  walk(tree)
  for (const image of images) {
    const url = image.url || definitions.get(image.identifier) || ''
    if (/^https?:\/\//i.test(url)) continue
    const data = url.match(/^data:image\/(png|jpeg|gif|webp);base64,([a-z0-9+/=]+)$/i)
    if (!data) throw new Error('博客图片必须是已读取的 PNG/JPEG/GIF/WebP 或网站图片；请在本地导入时同时选择配图')
    if (files.length >= 30) throw new Error('每篇最多 30 张本地图片')
    const base64 = data[2], bytes = atob(base64).length
    if (!bytes || bytes > 5 * 1024 * 1024) throw new Error('单张图片必须为 1 字节至 5 MiB')
    const imageName = `image-${files.length + 1}.${data[1].toLowerCase() === 'jpeg' ? 'jpg' : data[1].toLowerCase()}`
    files.push({ path: `notes/agent-imports/assets/${slug}/${imageName}`, content: base64, encoding: 'base64' })
    const start = image.position?.start.offset, end = image.position?.end.offset
    if (start === undefined || end === undefined) throw new Error('无法定位 Markdown 图片')
    const alt = (image.alt || '').replace(/[\\\[\]]/g, '\\$&')
    replacements.push({ start, end, value: `![${alt}](assets/${slug}/${imageName})` })
  }
  if (files.reduce((size, item) => size + item.content.length, 0) > 16 * 1024 * 1024) throw new Error('图片总量超过 16 MiB 上限')
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) markdown = markdown.slice(0, replacement.start) + replacement.value + markdown.slice(replacement.end)
  // Raw HTML images cannot be relocated safely without a browser DOM pass.
  if (htmlImage) throw new Error('博客 Markdown 中的 HTML 图片请先转换为 Markdown 图片语法')
  const metadata = {
    slug, title, category, categoryLabel: categories[category], categoryPath: [category],
    number: `A${digest.slice(0, 6)}`, date: new Date().toISOString().slice(0, 10).replaceAll('-', '.'),
    readTime: `${Math.max(1, Math.ceil(markdown.length / 900))} min`,
    summary: markdown.split(/\r?\n/).find(line => line.trim() && !/^\s*(#|```|!\[)/.test(line))?.slice(0, 150) || title,
    file, source: { provider: 'wechatsync' },
  }
  files.push({ path: file, content: markdown.replace(/^\uFEFF/, '').trimEnd() + '\n', encoding: 'utf-8' })
  files.push({ path: 'agent-notes.js', content: `/* Generated by power-notes-mcp / wechatsync. */\nwindow.POWER_AGENT_NOTES = ${JSON.stringify([...existing, metadata], null, 2)};\nwindow.POWER_NOTES.push(...window.POWER_AGENT_NOTES);\n`, encoding: 'utf-8' })
  return { slug, files }
}

function api(credentials: PowerNotesCredentials) {
  const repository = repositoryName(credentials.username)
  if (!credentials.password) throw new Error('请配置 GitHub Token')
  const url = new URL(credentials.url)
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('博客地址必须是 HTTPS 地址')
  return async (path = '', body?: unknown): Promise<any> => {
    const response = await fetch(`https://api.github.com/repos/${repository}${path}`, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${credentials.password}`, 'X-GitHub-Api-Version': '2022-11-28', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!response.ok) throw new Error(`GitHub 请求失败（HTTP ${response.status}），请检查 Token 的仓库 Contents 权限`)
    return response.json()
  }
}

async function snapshot(credentials: PowerNotesCredentials) {
  const request = api(credentials)
  const repository = await request()
  if (repository.permissions?.push !== true) throw new Error('GitHub 凭据没有此仓库的写入权限')
  const branch = repository.default_branch
  if (typeof branch !== 'string' || !branch) throw new Error('仓库默认分支无效')
  const ref = await request(`/git/ref/heads/${encodeURIComponent(branch)}`)
  const commit = await request(`/git/commits/${ref.object.sha}`)
  const tree = await request(`/git/trees/${commit.tree.sha}?recursive=1`)
  if (tree.truncated || !Array.isArray(tree.tree)) throw new Error('无法完整读取仓库文件列表，停止写入')
  const entry = tree.tree.find((item: any) => item.path === 'agent-notes.js')
  if (entry?.type !== 'blob' || entry.mode !== '100644' || !tree.tree.some((item: any) => item.path === 'taxonomy.js')) throw new Error('该仓库缺少 Power Notes 索引或分类文件')
  const blob = await request(`/git/blobs/${entry.sha}`)
  if (blob.encoding !== 'base64' || blob.size > 4 * 1024 * 1024) throw new Error('GitHub 索引编码或大小不兼容')
  const occupied = new Set<string>()
  for (const path of ['notes.js', 'deep-in-embedded.js']) {
    const source = tree.tree.find((item: any) => item.path === path)
    if (!source) continue
    if (source.type !== 'blob' || source.mode !== '100644') throw new Error('博客笔记目录不是普通文件')
    const data = await request(`/git/blobs/${source.sha}`)
    if (data.encoding !== 'base64' || data.size > 16 * 1024 * 1024) throw new Error('博客笔记目录过大或编码不兼容')
    for (const match of decode(data.content).matchAll(/["']?slug["']?\s*:\s*["']([^"']+)["']/g)) occupied.add(match[1])
  }
  return { request, branch, parent: ref.object.sha, tree: commit.tree.sha, entries: tree.tree, occupied, notes: readAgentIndex(decode(blob.content)) }
}

export async function testConnection(credentials: PowerNotesCredentials): Promise<{ success: boolean; error?: string }> {
  try { await snapshot(credentials); return { success: true } }
  catch (error) { return { success: false, error: error instanceof Error ? error.message : '博客连接失败' } }
}

/** Creates a new draft branch only. Never updates the default branch or merges. */
export async function publish(credentials: PowerNotesCredentials, article: { title: string; markdown?: string }): Promise<{ success: boolean; postId?: string; postUrl?: string; message?: string; error?: string }> {
  let postUrl: string | undefined
  let branchRequested = false
  try {
    const state = await snapshot(credentials)
    const draft = await draftFiles(article.title, article.markdown || '', credentials.category, state.notes)
    if (state.occupied.has(draft.slug) || state.entries.some((entry: any) => entry.path === `notes/agent-imports/${draft.slug}.md`)) throw new Error('目标 Markdown 或笔记标识已存在，停止覆盖')
    const changes = []
    for (const file of draft.files) {
      const blob = await state.request('/git/blobs', { content: file.content, encoding: file.encoding })
      changes.push({ path: file.path, mode: '100644', type: 'blob', sha: blob.sha })
    }
    const tree = await state.request('/git/trees', { base_tree: state.tree, tree: changes })
    const commit = await state.request('/git/commits', { message: `draft: ${article.title}`, tree: tree.sha, parents: [state.parent] })
    const branch = `codex/wechatsync-${crypto.randomUUID()}`
    postUrl = `https://github.com/${repositoryName(credentials.username)}/compare/${encodeURIComponent(state.branch)}...${encodeURIComponent(branch)}`
    branchRequested = true
    await state.request('/git/refs', { ref: `refs/heads/${branch}`, sha: commit.sha })
    const saved = await state.request(`/git/ref/heads/${encodeURIComponent(branch)}`)
    if (saved.object?.sha !== commit.sha) throw new Error('草稿分支回读不一致')
    return { success: true, postId: branch, postUrl, message: '已保存博客仓库草稿分支；审查比较链接并合并后才发布网站' }
  } catch (error) {
    return { success: false, ...(branchRequested ? { postUrl } : {}), error: `${error instanceof Error ? error.message : '博客同步失败'}${branchRequested ? '；草稿分支可能已创建，请先打开链接确认，避免重复上传' : ''}` }
  }
}
