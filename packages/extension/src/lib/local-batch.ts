import { LOCAL_LIMITS, localPath, type LocalFile, type PreparedLocalDocument } from './local-document'
import type { SyncResult } from '../components/sync-dialog/types'

export const BATCH_LIMIT = 100
export const isLocalDocument = (file: LocalFile) => /\.(md|markdown|html?)$/i.test(file.name)
export const isImportFile = (file: LocalFile) => /\.(md|markdown|html?|png|jpe?g|gif|webp)$/i.test(file.name)

function cleanPath(value: string): string {
  return value.trim().replace(/^(["'])(.*)\1$/, '$2').replace(/\\/g, '/').replace(/\/+$/, '')
}

/** Absolute paths are aliases for an explicitly selected directory, never disk access. */
export function relativeImportPath(value: string, rootName: string, absoluteRoot = ''): string {
  let path = cleanPath(value)
  if (/^[a-z][\w+.-]*:\/\//i.test(path) || path.includes('\0')) throw new Error('请输入本地文件或文件夹路径，不支持网址')
  const absolute = /^[a-z]:/i.test(path) || path.startsWith('/')
  const root = cleanPath(absoluteRoot)
  if (absolute) {
    if (!root || !(/^[a-z]:\//i.test(root) || root.startsWith('/'))) throw new Error('使用完整路径时，请填写已授权目录的完整路径')
    if (root.split('/').pop()?.toLowerCase() !== rootName.toLowerCase()) throw new Error('目录完整路径的末级名称与已授权目录不一致')
    const ignoreCase = /^[a-z]:\//i.test(root) || root.startsWith('//')
    const normalizedPath = ignoreCase ? path.toLowerCase() : path
    const normalizedRoot = ignoreCase ? root.toLowerCase() : root
    if (normalizedPath !== normalizedRoot && !normalizedPath.startsWith(normalizedRoot + '/')) throw new Error('路径不在已授权目录内')
    path = path.slice(root.length).replace(/^\//, '')
  } else if (path === rootName || path.startsWith(rootName + '/')) {
    path = path.slice(rootName.length).replace(/^\//, '')
  }
  const segments: string[] = []
  for (const part of path.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (!segments.length) throw new Error('路径不能越出已授权目录')
      segments.pop()
    } else {
      if (/[:*?<>|]/.test(part)) throw new Error('路径包含不支持的字符')
      segments.push(part)
    }
  }
  return segments.join('/')
}

export function documentsAtPaths(files: LocalFile[], text: string, rootName: string, absoluteRoot = ''): { documents: LocalFile[]; errors: string[] } {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  if (lines.length > 200) throw new Error('一次最多输入 200 条路径')
  const documents = new Map<string, LocalFile>(), errors: string[] = []
  const ignoreCase = /^[a-z]:[\\/]/i.test(absoluteRoot) || /^[\\/]{2}/.test(absoluteRoot)
  const matchKey = (value: string) => ignoreCase ? value.toLowerCase() : value
  for (const line of lines.length ? lines : ['.']) {
    try {
      const path = relativeImportPath(line, rootName, absoluteRoot)
      const target = matchKey([rootName, path].filter(Boolean).join('/'))
      const matches = files.filter(file => isLocalDocument(file) && (matchKey(localPath(file)) === target || matchKey(localPath(file)).startsWith(target + '/')))
      if (!matches.length) throw new Error('没有找到 Markdown/HTML 文档，请检查路径或重新授权目录')
      for (const file of matches) documents.set(localPath(file), file)
    } catch (error) { errors.push(`${line}：${(error as Error).message}`) }
  }
  if (documents.size > BATCH_LIMIT) throw new Error(`一次最多添加 ${BATCH_LIMIT} 份文档，请缩小路径范围`)
  return { documents: [...documents.values()], errors }
}

export type BatchStatus = 'pending' | 'syncing' | 'completed' | 'failed' | 'blocked' | 'unknown'
export interface BatchItem {
  path: string
  title: string
  titleOverride?: string
  selected: boolean
  status: BatchStatus
  results: SyncResult[]
  error?: string
}

export function canRunBatchItem(item: BatchItem, targets: string[]): boolean {
  if (!item.selected || item.status === 'syncing' || item.status === 'unknown') return false
  if (item.results.some(result => targets.includes(result.platform) && !result.success && result.postUrl)) return false
  return targets.some(target => !item.results.some(result => result.platform === target && result.success))
}

export function checkPreparedForSync(prepared: PreparedLocalDocument): void {
  if (!prepared.title.trim()) throw new Error('请填写文档标题')
  if (prepared.missingImages.length) throw new Error(`图片缺失：${prepared.missingImages.join('、')}`)
  if (new TextEncoder().encode(JSON.stringify(prepared)).byteLength * 3 > 32 * 1024 * 1024) throw new Error('正文与内嵌图片过大，请压缩图片或拆分文档')
}

/** Only one article is prepared/sent at a time. Ambiguous replies never trigger a retry. */
export async function runDocumentBatch(items: BatchItem[], options: {
  targets: string[]
  prepare(item: BatchItem): Promise<PreparedLocalDocument>
  send(item: BatchItem, prepared: PreparedLocalDocument, targets: string[]): Promise<SyncResult[]>
  update(item: BatchItem): void
  shouldStop(): boolean
}): Promise<void> {
  for (const original of items) {
    if (options.shouldStop()) break
    if (!canRunBatchItem(original, options.targets)) continue
    const targets = options.targets.filter(target => !original.results.some(result => result.platform === target && result.success))
    let item: BatchItem = { ...original, status: 'syncing', error: undefined }
    options.update(item)
    let prepared: PreparedLocalDocument
    try {
      prepared = await options.prepare(item)
      checkPreparedForSync(prepared)
      item = { ...item, title: prepared.title }
    } catch (error) {
      options.update({ ...item, status: 'blocked', error: (error as Error).message })
      continue
    }
    if (options.shouldStop()) { options.update({ ...item, status: 'pending' }); break }
    try {
      const results = await options.send(item, prepared, targets)
      if (!Array.isArray(results) || targets.some(target => results.filter(result => result.platform === target && typeof result.success === 'boolean').length !== 1)) throw new Error('后台结果不完整，请检查同步历史后再操作')
      const merged = [...item.results.filter(result => !targets.includes(result.platform)), ...results.filter(result => targets.includes(result.platform))]
      const failed = merged.filter(result => !result.success)
      options.update({ ...item, results: merged, status: failed.length ? 'failed' : 'completed', error: failed.map(result => result.error || '同步失败').join('；') || undefined })
    } catch (error) {
      options.update({ ...item, status: 'unknown', error: `同步结果待确认：${(error as Error).message}。请检查历史，避免重复创建文档。` })
      break // The worker may still own the clipboard; do not start another document.
    }
  }
}

export function validateImportSelection(files: LocalFile[]): LocalFile[] {
  const supported = files.filter(isImportFile)
  if (supported.reduce((sum, file) => sum + file.size, 0) > LOCAL_LIMITS.total) throw new Error('所选文档与图片总量超过 50 MiB')
  if (supported.filter(isLocalDocument).length > BATCH_LIMIT) throw new Error(`一次最多添加 ${BATCH_LIMIT} 份文档`)
  const paths = supported.map(localPath)
  if (new Set(paths).size !== paths.length) throw new Error('所选文件路径重复，请使用文件夹选择以区分同名文件')
  return supported
}
