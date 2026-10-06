import { useEffect, useRef, useState } from 'react'
import { FileUp, FolderOpen, RefreshCw } from 'lucide-react'
import { SyncDialog } from '@/components/sync-dialog'
import type { DialogStatus, Platform, PlatformProgress, SyncResult } from '@/components/sync-dialog/types'
import { localPath, prepareLocalDocument, previewDocument, type LocalFile, type PreparedLocalDocument } from '../lib/local-document'
import { canRunBatchItem, checkPreparedForSync, documentsAtPaths, isLocalDocument, runDocumentBatch, validateImportSelection, type BatchItem } from '../lib/local-batch'
import { directoryPicker, readImportDirectory } from '../lib/local-directory'
import { BatchImportPanel } from './BatchImportPanel'
import { prepareOneNoteImport, oneNoteRedirectUri } from '../lib/onenote'
import { requestFeishuClipboardPermissions } from '../lib/feishu/permissions'

export function LocalImportPage() {
  const [files, setFiles] = useState<LocalFile[]>([])
  const [batchItems, setBatchItems] = useState<BatchItem[]>([])
  const [previousItems, setPreviousItems] = useState<BatchItem[]>([])
  const [batchRunning, setBatchRunning] = useState(false)
  const [stopRequested, setStopRequested] = useState(false)
  const [rootName, setRootName] = useState('')
  const [absoluteRoot, setAbsoluteRoot] = useState('')
  const [pathText, setPathText] = useState('')
  const batchRef = useRef<BatchItem[]>([])
  const directoryFiles = useRef<LocalFile[]>([])
  const stopBatch = useRef(false)
  const [documentPath, setDocumentPath] = useState('')
  const [prepared, setPrepared] = useState<PreparedLocalDocument | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [platforms, setPlatforms] = useState<Platform[]>([])
  const [selectedPlatforms, setSelectedPlatforms] = useState<string[]>([])
  const [status, setStatus] = useState<DialogStatus>('idle')
  const [results, setResults] = useState<SyncResult[]>([])
  const [progress, setProgress] = useState<Map<string, PlatformProgress>>(new Map())
  const [sourceUrl, setSourceUrl] = useState('')
  const [clientId, setClientId] = useState('')
  const syncId = useRef<string | null>(null)
  const uploadPending = useRef(false)
  const generation = useRef(0)
  const directoryInput = useRef<HTMLInputElement>(null)
  const locked = busy || status === 'syncing' || batchRunning
  const documents = files.filter(isLocalDocument)

  const commitItems = (items: BatchItem[]) => { batchRef.current = items; setBatchItems(items) }
  const updateItem = (item: BatchItem, persist = false) => {
    const items = batchRef.current.map(previous => previous.path === item.path ? item : previous)
    commitItems(items)
    if (persist) chrome.storage.local.set({ localBatchResult: { timestamp: Date.now(), items } }).catch(() => setError('批次结果摘要保存失败，请保留当前页面查看结果。'))
  }

  const loadPlatforms = async () => {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'CHECK_ALL_AUTH', payload: { forceRefresh: true } })
      if (response?.error) throw new Error(response.error)
      setPlatforms(response.platforms || [])
    } catch (e) { setError(`读取平台失败：${(e as Error).message}`) }
  }

  useEffect(() => {
    directoryInput.current?.setAttribute('webkitdirectory', '')
    loadPlatforms()
    const loadSaved = async () => {
      const saved = await chrome.storage.local.get(['oneNoteClientId', 'selectedPlatforms', 'localBatchResult'])
      setClientId(saved.oneNoteClientId || '')
      setSelectedPlatforms(saved.selectedPlatforms || [])
      if (Array.isArray(saved.localBatchResult?.items)) setPreviousItems(saved.localBatchResult.items)
    }
    loadSaved().catch(() => setError('读取本地设置失败，请刷新页面重试。'))
    const listener = (message: any) => {
      if (!syncId.current || message.syncId !== syncId.current) return
      if (message.type === 'SYNC_PROGRESS' && message.payload?.result) {
        setResults(previous => [...previous.filter(result => result.platform !== message.payload.result.platform), message.payload.result])
      }
      if (message.type === 'SYNC_DETAIL_PROGRESS' && message.payload?.platform) {
        setProgress(previous => new Map(previous).set(message.payload.platform, message.payload))
      }
    }
    chrome.runtime.onMessage.addListener(listener)
    return () => { chrome.runtime.onMessage.removeListener(listener); generation.current++; stopBatch.current = true }
  }, [])

  const reset = () => {
    if (locked) return
    syncId.current = null
    setStatus('idle'); setResults([]); setProgress(new Map()); setError(null)
  }

  const prepare = async (file: LocalFile, selection: LocalFile[]) => {
    const revision = ++generation.current
    setBusy(true); setError(null); setPrepared(null); setStatus('idle'); setResults([])
    try {
      const article = await prepareLocalDocument(file, selection)
      if (generation.current === revision) {
        const item = batchRef.current.find(item => item.path === localPath(file))
        if (item?.titleOverride !== undefined) article.title = item.titleOverride
        setPrepared(article)
        if (item) {
          updateItem({ ...item, title: article.title })
          setResults(item.results)
          setStatus(item.results.length ? 'completed' : 'idle')
        }
      }
    } catch (e) {
      if (generation.current === revision) setError((e as Error).message)
    } finally { if (generation.current === revision) setBusy(false) }
  }

  const selectFiles = (list: FileList | null) => {
    if (!list || locked) return
    try {
      const selection = validateImportSelection(Array.from(list))
      const doc = selection.find(isLocalDocument)
      if (!doc) throw new Error('请选择 Markdown/HTML 文档及配套图片')
      setFiles(selection)
      commitItems(selection.filter(isLocalDocument).map(file => ({ path: localPath(file), title: file.name.replace(/\.(md|markdown|html?)$/i, ''), selected: true, status: 'pending', results: [] })))
      if (doc.webkitRelativePath) { directoryFiles.current = selection; setRootName(localPath(doc).split('/')[0]) }
      setDocumentPath(localPath(doc))
      prepare(doc, selection)
    } catch (e) { setError((e as Error).message) }
  }

  const authorizeDirectory = async () => {
    if (locked) return
    const picker = directoryPicker()
    if (!picker) { directoryInput.current?.click(); return }
    setBusy(true); setError(null)
    try {
      const directory = await picker({ mode: 'read', id: 'wechatsync-local-import' })
      const selection = await readImportDirectory(directory)
      directoryFiles.current = selection
      setRootName(directory.name)
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setError(`读取目录失败：${(e as Error).message}`)
    } finally { setBusy(false) }
  }

  const addPaths = () => {
    if (locked || !rootName) return
    try {
      const matched = documentsAtPaths(directoryFiles.current, pathText, rootName, absoluteRoot)
      if (!matched.documents.length) throw new Error(matched.errors.join('\n') || '没有找到文档')
      const resources = directoryFiles.current.filter(file => !isLocalDocument(file))
      const merged = new Map(files.map(file => [localPath(file), file]))
      for (const file of [...resources, ...matched.documents]) if (!merged.has(localPath(file))) merged.set(localPath(file), file)
      const selection = validateImportSelection([...merged.values()])
      const items = [...batchRef.current]
      for (const file of matched.documents) if (!items.some(item => item.path === localPath(file))) items.push({ path: localPath(file), title: file.name.replace(/\.(md|markdown|html?)$/i, ''), selected: true, status: 'pending', results: [] })
      setFiles(selection); commitItems(items)
      if (!prepared) {
        const file = matched.documents[0]
        setDocumentPath(localPath(file))
        prepare(file, selection).finally(() => { if (matched.errors.length) setError(matched.errors.join('\n')) })
      } else setError(matched.errors.length ? matched.errors.join('\n') : null)
    } catch (e) { setError((e as Error).message) }
  }

  const previewPath = (path: string) => {
    if (locked) return
    const file = files.find(file => localPath(file) === path)
    if (file) { setDocumentPath(path); prepare(file, files) }
  }

  const sendDocument = async (article: PreparedLocalDocument, targets: string[]): Promise<SyncResult[]> => {
    const id = `local_${Date.now()}_${crypto.randomUUID()}`
    syncId.current = id
    setStatus('syncing'); setResults([]); setProgress(new Map())
    const response = await chrome.runtime.sendMessage({
      type: 'SYNC_ARTICLE', payload: {
        article: { title: article.title, markdown: article.markdown, html: article.html, content: article.html, ...(article.sourceUrl ? { sourceUrl: article.sourceUrl } : {}) },
        platforms: targets, source: 'local', syncId: id,
      },
    })
    if (response?.error) throw new Error(response.error)
    if (!Array.isArray(response?.results)) throw new Error('后台没有返回同步结果，请查看同步历史后再重试')
    if (response.rateLimitWarning) setError(response.rateLimitWarning)
    return response.results
  }

  const startBatch = async () => {
    if (locked || uploadPending.current || !selectedPlatforms.length || !batchRef.current.some(item => canRunBatchItem(item, selectedPlatforms))) return
    uploadPending.current = true
    setBatchRunning(true); setStopRequested(false); stopBatch.current = false; setError(null)
    try {
      // Request from this click before asynchronous preparation or messages.
      if (selectedPlatforms.includes('feishu') && !await requestFeishuClipboardPermissions()) throw new Error('未授予飞书粘贴权限，尚未创建飞书文档。')
      await runDocumentBatch(batchRef.current.map(item => ({ ...item })), {
        targets: [...selectedPlatforms], shouldStop: () => stopBatch.current,
        prepare: async item => {
          const file = files.find(file => localPath(file) === item.path)
          if (!file) throw new Error('源文件已不可用，请重新选择')
          syncId.current = null
          const article = await prepareLocalDocument(file, files)
          if (item.titleOverride !== undefined) article.title = item.titleOverride
          setDocumentPath(item.path); setPrepared(article); setResults([])
          return article
        },
        send: (_item, article, targets) => sendDocument(article, targets),
        update: item => { updateItem(item, true); setResults(item.results); if (item.status !== 'syncing') setStatus(item.results.length ? 'completed' : 'idle') },
      })
    } catch (e) { setError((e as Error).message) }
    finally {
      setBatchRunning(false); uploadPending.current = false
      setStatus(previous => previous === 'syncing' ? 'idle' : previous)
    }
  }

  const readOneNote = async () => {
    if (locked) return
    setBusy(true); setPrepared(null); setError(null); setResults([]); setStatus('idle')
    try {
      if (!clientId.trim()) throw new Error('请填写用于 Microsoft 登录的应用 Client ID')
      await chrome.storage.local.set({ oneNoteClientId: clientId.trim() })
      const response = await chrome.runtime.sendMessage({ type: 'ONENOTE_READ', payload: { sourceUrl: sourceUrl.trim(), clientId: clientId.trim() } })
      if (response?.error) throw new Error(response.error)
      const page = response?.page || response
      if (!page?.html || !page?.title) throw new Error('没有读取到 OneNote 页面内容')
      const article = prepareOneNoteImport(page)
      setFiles([]); commitItems([]); setDocumentPath('')
      setPrepared({ ...article, missingImages: article.missingImages || [], imageCount: (article.html.match(/<img\b/gi) || []).length })
    } catch (e) { setError((e as Error).message) }
    finally { setBusy(false) }
  }

  const disconnectOneNote = async () => {
    setBusy(true); setError(null)
    try {
      const response = await chrome.runtime.sendMessage({ type: 'ONENOTE_DISCONNECT' })
      if (response?.error) throw new Error(response.error)
      setPrepared(null)
      setSourceUrl('')
    } catch (e) { setError((e as Error).message) }
    finally { setBusy(false) }
  }

  const startSync = async (targets = selectedPlatforms) => {
    if (!prepared || prepared.missingImages.length || !targets.length || locked || uploadPending.current) return
    try { checkPreparedForSync(prepared) } catch (e) { setError((e as Error).message); return }
    const item = batchRef.current.find(item => item.path === documentPath)
    if (item && !canRunBatchItem({ ...item, selected: true }, targets)) { setError('当前项已完成或结果需要检查，请查看文档与同步历史。'); return }
    if (targets.includes('feishu') && results.some(result => result.platform === 'feishu' && !result.success && result.postUrl)) {
      setError('已有未完成的飞书文档，请先打开结果中的文档检查；如确需新建另一份，请重置后重新同步。')
      return
    }
    uploadPending.current = true
    // Permission must be requested from this click, before any asynchronous preflight.
    if (targets.includes('feishu')) {
      try {
        const granted = await requestFeishuClipboardPermissions()
        if (!granted) { setError('未授予飞书粘贴权限，尚未创建飞书文档。'); uploadPending.current = false; return }
      } catch (e) { setError((e as Error).message); uploadPending.current = false; return }
    }
    try {
      const remaining = item ? targets.filter(target => !item.results.some(result => result.platform === target && result.success)) : targets
      setError(null)
      const sent = await sendDocument(prepared, remaining)
      if (remaining.some(target => sent.filter(result => result.platform === target && typeof result.success === 'boolean').length !== 1)) throw new Error('后台结果不完整，请查看同步历史')
      const merged = [...(item?.results || []).filter(result => !remaining.includes(result.platform)), ...sent]
      setResults(merged); setStatus('completed')
      if (item) updateItem({ ...item, title: prepared.title, results: merged, status: merged.every(result => result.success) ? 'completed' : 'failed', error: merged.filter(result => !result.success).map(result => result.error).join('；') || undefined })
    } catch (e) {
      setError((e as Error).message); setStatus('idle')
      if (item) updateItem({ ...item, status: 'unknown', error: '同步结果待确认，请检查历史，避免重复创建文档' })
    }
    finally { uploadPending.current = false }
  }

  const selectPlatforms = (ids: string[]) => {
    if (locked) return
    setSelectedPlatforms(ids)
    chrome.storage.local.set({ selectedPlatforms: ids })
  }
  const syncArticle = prepared && !prepared.missingImages.length ? { title: prepared.title, content: prepared.html } : null

  return (
    <main className="min-h-screen bg-muted/30 p-6">
      <div className="max-w-7xl mx-auto space-y-5">
        <header className="flex items-center gap-3"><img src="/assets/icon-48.png" className="w-8 h-8" alt="文章同步助手" /><div><h1 className="text-xl font-semibold">导入本地文档</h1><p className="text-sm text-muted-foreground">批量选择文档或按本地路径添加，检查预览后逐份同步。</p></div></header>
        <div className="grid lg:grid-cols-[1fr_380px] gap-5">
          <section className="bg-background rounded-xl border p-5 space-y-4">
            <div className="flex gap-3 flex-wrap">
              <label className={`flex gap-2 items-center px-4 py-2 rounded-lg bg-primary text-primary-foreground ${locked ? 'opacity-50' : 'cursor-pointer'}`}><FileUp size={18} />选择文档与图片<input type="file" multiple accept=".md,.markdown,.html,.htm,.png,.jpg,.jpeg,.gif,.webp" disabled={locked} onChange={event => selectFiles(event.target.files)} className="sr-only" /></label>
              <label className={`flex gap-2 items-center px-4 py-2 rounded-lg border ${locked ? 'opacity-50' : 'cursor-pointer'}`}><FolderOpen size={18} />选择整个文件夹<input ref={directoryInput} type="file" multiple disabled={locked} onChange={event => selectFiles(event.target.files)} className="sr-only" /></label>
            </div>
            <p className="text-xs text-muted-foreground">Markdown/HTML 不超过 5 MiB，单图 10 MiB，所选文件总量 50 MiB。支持 PNG/JPEG/GIF/WebP；图片与文档一并选择，或选择包含它们的文件夹。</p>
            <BatchImportPanel items={batchItems} targets={selectedPlatforms} locked={locked} running={batchRunning} stopRequested={stopRequested} rootName={rootName} absoluteRoot={absoluteRoot} pathText={pathText} previousItems={previousItems}
              onRootChange={setAbsoluteRoot} onPathsChange={setPathText} onAuthorize={authorizeDirectory} onAddPaths={addPaths}
              onToggle={(path, selected) => commitItems(batchRef.current.map(item => item.path === path ? { ...item, selected } : item))}
              onSelectAll={selected => commitItems(batchRef.current.map(item => ({ ...item, selected })))}
              onClear={() => { setFiles([]); commitItems([]); setPrepared(null); setDocumentPath(''); reset() }}
              onPreview={previewPath} onStart={startBatch} onStop={() => { stopBatch.current = true; setStopRequested(true) }} />
            {documents.length > 0 && <label className="block text-sm">文档<select className="w-full border rounded-lg p-2 mt-1 bg-background" disabled={locked} value={documentPath} onChange={event => { setDocumentPath(event.target.value); const file = documents.find(item => localPath(item) === event.target.value); if (file) prepare(file, files) }}>{documents.map(file => <option key={localPath(file)} value={localPath(file)}>{localPath(file)}</option>)}</select></label>}
            <details className="border rounded-lg p-3">
              <summary className="cursor-pointer text-sm">从 OneNote 在线页面读取</summary>
              <div className="space-y-3 mt-3">
                <label className="block text-sm">OneNote 页面链接<input type="url" className="w-full mt-1 border rounded-lg p-2 bg-background" placeholder="https://…" value={sourceUrl} disabled={locked} onChange={event => setSourceUrl(event.target.value)} /></label>
                <label className="block text-sm">Microsoft 应用 Client ID<input className="w-full mt-1 border rounded-lg p-2 bg-background" value={clientId} disabled={locked} onChange={event => setClientId(event.target.value)} /></label>
                <p className="text-xs text-muted-foreground">使用 Microsoft 委托登录读取你的页面。应用注册需配置下方 SPA 重定向地址和 Notes.Read 权限；Client ID 在本扩展保存，登录令牌不会出现在预览中。</p>
                <label className="block text-xs">SPA 重定向地址<input aria-label="OneNote SPA 重定向地址" readOnly className="w-full mt-1 border rounded p-2 bg-muted font-mono text-xs" value={oneNoteRedirectUri()} /></label>
                <div className="flex gap-2">
                  <button onClick={readOneNote} disabled={locked || !sourceUrl.trim()} className="border rounded-lg px-4 py-2 disabled:opacity-50">登录并读取预览</button>
                  <button onClick={disconnectOneNote} disabled={locked} className="border rounded-lg px-4 py-2 disabled:opacity-50">断开 OneNote 登录</button>
                </div>
              </div>
            </details>
            {busy && <p role="status" className="text-sm">正在读取和准备预览…</p>}
            {error && <p role="alert" className="text-sm text-red-600 bg-red-50 rounded-lg p-3 whitespace-pre-wrap">{error}</p>}
            {prepared && <>
              <label className="block text-sm">文档标题<input className="w-full mt-1 border rounded-lg p-2 bg-background" value={prepared.title} disabled={locked} onChange={event => {
                setPrepared({ ...prepared, title: event.target.value })
                const item = batchRef.current.find(item => item.path === documentPath)
                if (item) updateItem({ ...item, title: event.target.value, titleOverride: event.target.value })
              }} /></label>
              <p className="text-xs text-muted-foreground">已识别 {prepared.imageCount} 个图片引用。预览中链接不可导航，远程图片在同步时读取。</p>
              {prepared.warnings.map(warning => <p key={warning} className="text-sm text-amber-700 bg-amber-50 p-2 rounded">{warning}</p>)}
              {prepared.missingImages.length > 0 && <div role="alert" className="text-sm text-red-600 bg-red-50 p-3 rounded-lg"><strong>图片缺失，已阻止上传：</strong><ul className="list-disc pl-5">{prepared.missingImages.map(src => <li key={src}>{src}</li>)}</ul><p>请重新选择包含文档和图片的文件夹。</p></div>}
              <iframe title="安全文档预览" sandbox="" srcDoc={previewDocument(prepared.html)} className="w-full min-h-[600px] border rounded-lg bg-white" />
            </>}
          </section>
          <aside className="bg-background border rounded-xl overflow-hidden flex flex-col min-h-[600px]">
            <div className="p-4 border-b flex justify-between items-center"><h2 className="font-medium">同步平台</h2><button aria-label="刷新平台登录状态" disabled={locked} onClick={loadPlatforms} className="p-2 rounded hover:bg-muted"><RefreshCw size={16} /></button></div>
            <p className="text-xs text-muted-foreground px-4 pt-3">飞书首次同步会申请剪贴板权限，编辑新文档时浏览器可能显示调试提示。请保持此页打开，等待同步结果。</p>
            {status === 'syncing' && <p className="text-xs text-amber-700 px-4 pt-3">当前同步尚未结束，关闭此页不会取消后台上传。</p>}
            <SyncDialog article={syncArticle} platforms={platforms} status={busy ? 'loading' : status} selectedPlatforms={selectedPlatforms} results={results} platformProgress={progress} error={null} onTogglePlatform={id => selectPlatforms(selectedPlatforms.includes(id) ? selectedPlatforms.filter(value => value !== id) : [...selectedPlatforms, id])} onSelectAll={() => selectPlatforms(platforms.filter(platform => platform.isAuthenticated).map(platform => platform.id))} onDeselectAll={() => selectPlatforms([])} onStartSync={() => startSync()} onRetryFailed={() => startSync(results.filter(result => !result.success).map(result => result.platform))} onReset={reset} onCancel={() => setError('后台上传正在进行，暂不支持取消；请等待结果，避免重复创建文档。')} className="flex-1" />
          </aside>
        </div>
      </div>
    </main>
  )
}
