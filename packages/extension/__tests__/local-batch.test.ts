import { describe, expect, it } from 'vitest'
import { BATCH_LIMIT, canRunBatchItem, documentsAtPaths, relativeImportPath, runDocumentBatch, validateImportSelection, type BatchItem } from '../src/lib/local-batch'
import { readImportDirectory, type ImportDirectory } from '../src/lib/local-directory'
import { LOCAL_LIMITS, type LocalFile, type PreparedLocalDocument } from '../src/lib/local-document'

const file = (path: string, size = 1): LocalFile => ({ name: path.split('/').pop()!, webkitRelativePath: path, size, type: 'text/plain', text: async () => path, arrayBuffer: async () => new ArrayBuffer(size) })
const item = (path: string): BatchItem => ({ path, title: path, selected: true, status: 'pending', results: [] })
const prepared = (title: string): PreparedLocalDocument => ({ title, html: `<p>${title}</p>`, missingImages: [], warnings: [], imageCount: 0 })
const result = (platform = 'feishu', success = true) => ({ platform, success })

describe('authorized local paths', () => {
  const files = [file('笔记/文章/A.md'), file('笔记/文章/二.md'), file('笔记/其他.md'), file('笔记/文章/p.png')]
  it('maps quoted Windows paths and mixed separators within the selected root', () => {
    expect(relativeImportPath('"C:\\笔记\\文章\\二.md"', '笔记', 'C:\\笔记')).toBe('文章/二.md')
    expect(documentsAtPaths(files, 'c:/笔记/文章/a.MD', '笔记', 'C:\\笔记').documents).toEqual([files[0]])
  })
  it('matches folders recursively, deduplicates overlapping paths and reports missing paths separately', () => {
    const matched = documentsAtPaths(files, '文章\n文章/A.md\n不存在', '笔记')
    expect(matched.documents).toEqual(files.slice(0, 2))
    expect(matched.errors).toHaveLength(1)
    expect(documentsAtPaths(files, '', '笔记').documents).toEqual(files.slice(0, 3))
  })
  it('supports UNC aliases and selected-root relative paths', () => {
    expect(documentsAtPaths(files, '//server/share/笔记/文章/a.md', '笔记', '//server/share/笔记').documents).toEqual([files[0]])
    expect(relativeImportPath('笔记/文章/../其他.md', '笔记')).toBe('其他.md')
  })
  it.each(['C:\\笔记外\\a.md', 'C:\\笔记\\..\\a.md', '../a.md', 'https://example.com/a.md', 'file:///C:/笔记/a.md'])('rejects escape or URL %s', path => {
    expect(() => relativeImportPath(path, '笔记', 'C:\\笔记')).toThrow()
  })
  it('requires an absolute alias consistent with the granted directory name', () => {
    expect(() => relativeImportPath('C:\\笔记\\a.md', '笔记')).toThrow('完整路径')
    expect(() => relativeImportPath('C:\\其他\\a.md', '笔记', 'C:\\其他')).toThrow('不一致')
  })
  it('bounds documents and input lines, excludes unrelated files, and detects duplicate paths', () => {
    expect(() => documentsAtPaths(Array.from({ length: BATCH_LIMIT + 1 }, (_, i) => file(`笔记/${i}.md`)), '', '笔记')).toThrow('100')
    expect(() => documentsAtPaths(files, Array(201).fill('文章').join('\n'), '笔记')).toThrow('200')
    expect(validateImportSelection([file('a.md'), file('a.exe')])).toHaveLength(1)
    expect(() => validateImportSelection([file('a.md'), file('a.md')])).toThrow('重复')
    expect(() => validateImportSelection([file('a.md', LOCAL_LIMITS.total + 1)])).toThrow('50 MiB')
  })
})

describe('serial document queue', () => {
  it('prepares and sends separate articles sequentially, preserving already successful targets', async () => {
    const items = [item('one'), { ...item('two'), results: [result('other')] }]
    const events: string[] = [], updates: BatchItem[] = []
    await runDocumentBatch(items, { targets: ['feishu', 'other'], shouldStop: () => false,
      prepare: async item => { events.push(`prepare:${item.path}`); return prepared(item.path) },
      send: async (item, article, targets) => { events.push(`send:${item.path}:${targets.join(',')}`); expect(article.title).toBe(item.path); return targets.map(platform => result(platform)) },
      update: item => updates.push(item),
    })
    expect(events).toEqual(['prepare:one', 'send:one:feishu,other', 'prepare:two', 'send:two:feishu'])
    expect(updates.filter(item => item.status === 'completed')).toHaveLength(2)
    expect(updates.at(-1)?.results).toEqual([result('other'), result('feishu')])
    expect(canRunBatchItem(updates.at(-1)!, ['feishu', 'other'])).toBe(false)
  })
  it('continues after preparation errors and explicit upload failure', async () => {
    const updates: BatchItem[] = []
    await runDocumentBatch(['missing', 'failed', 'ok'].map(item), { targets: ['feishu'], shouldStop: () => false,
      prepare: async item => ({ ...prepared(item.path), missingImages: item.path === 'missing' ? ['p.png'] : [] }),
      send: async item => [result('feishu', item.path !== 'failed')], update: item => updates.push(item),
    })
    expect(updates.filter(item => item.status !== 'syncing').map(item => item.status)).toEqual(['blocked', 'failed', 'completed'])
  })
  it.each(['throws', 'incomplete'])('stops on ambiguous %s response, preventing clipboard reuse and retries', async mode => {
    const updates: BatchItem[] = [], sent: string[] = []
    await runDocumentBatch(['one', 'two'].map(item), { targets: ['feishu'], shouldStop: () => false,
      prepare: async item => prepared(item.path), send: async item => { sent.push(item.path); if (mode === 'throws') throw Error('channel closed'); return [] }, update: item => updates.push(item),
    })
    expect(sent).toEqual(['one'])
    expect(updates.at(-1)?.status).toBe('unknown')
    expect(canRunBatchItem(updates.at(-1)!, ['feishu'])).toBe(false)
  })
  it('never recreates a failed Feishu document with an existing URL', () => {
    expect(canRunBatchItem({ ...item('one'), status: 'failed', results: [{ ...result('feishu', false), postUrl: 'https://tenant.feishu.cn/docx/test' }] }, ['feishu'])).toBe(false)
  })
  it('stops after completing the current document', async () => {
    let stop = false
    const updates: BatchItem[] = []
    await runDocumentBatch(['one', 'two'].map(item), { targets: ['feishu'], shouldStop: () => stop,
      prepare: async item => prepared(item.path), send: async () => { stop = true; return [result()] }, update: item => updates.push(item),
    })
    expect(updates.map(item => item.path)).toEqual(['one', 'one'])
    expect(updates.at(-1)?.status).toBe('completed')
  })
})

describe('directory enumeration', () => {
  const directory = (name: string, entries: any[]): ImportDirectory => ({ name, kind: 'directory', async *values() { yield* entries } })
  const handle = (name: string, size = 1) => ({ name, kind: 'file', getFile: async () => ({ name, size, type: 'text/plain', text: async () => name, arrayBuffer: async () => new ArrayBuffer(size) }) })
  it('retains root-relative read-only references and excludes unsupported files', async () => {
    const files = await readImportDirectory(directory('笔记', [directory('文章', [handle('a.md'), handle('p.png'), handle('secret.exe')])]))
    expect(files.map(file => file.webkitRelativePath)).toEqual(['笔记/文章/a.md', '笔记/文章/p.png'])
    expect(await files[0].text()).toBe('a.md')
  })
  it('bounds directory storage and entry count', async () => {
    await expect(readImportDirectory(directory('root', [handle('large.md', LOCAL_LIMITS.total + 1)]))).rejects.toThrow('50 MiB')
    await expect(readImportDirectory(directory('root', Array.from({ length: 5001 }, (_, i) => handle(`${i}.exe`))))).rejects.toThrow('5000')
  })
})
