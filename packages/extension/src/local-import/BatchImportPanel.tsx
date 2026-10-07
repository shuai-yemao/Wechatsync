import { canRunBatchItem, type BatchItem } from '../lib/local-batch'

const labels = { pending: '待上传', syncing: '正在同步', completed: '已完成', failed: '同步失败', blocked: '准备失败', unknown: '结果待确认' }

export function BatchImportPanel(props: {
  items: BatchItem[]
  targets: string[]
  locked: boolean
  running: boolean
  stopRequested: boolean
  rootName: string
  absoluteRoot: string
  pathText: string
  previousItems: BatchItem[]
  onRootChange(value: string): void
  onPathsChange(value: string): void
  onAuthorize(): void
  onAddPaths(): void
  onToggle(path: string, selected: boolean): void
  onSelectAll(selected: boolean): void
  onClear(): void
  onPreview(path: string): void
  onStart(): void
  onStop(): void
}) {
  const eligible = props.items.filter(item => canRunBatchItem(item, props.targets)).length
  const renderResults = (item: BatchItem) => <>
    {item.error && <p className="text-xs text-red-700 whitespace-pre-wrap max-w-md">{item.error}</p>}
    {item.results.map(result => <div key={result.platform} className="text-xs mt-1">
      <span>{result.platformName || result.platform}：{result.success ? '成功' : '失败'} </span>
      {result.postUrl && /^https?:\/\//i.test(result.postUrl) && <a className="text-primary underline" href={result.postUrl} target="_blank" rel="noopener noreferrer">{result.success ? '查看文档' : '检查已创建文档'}</a>}
    </div>)}
  </>
  return <section className="border rounded-lg p-4 space-y-3" aria-label="批量文档与路径">
    <details>
      <summary className="cursor-pointer font-medium">通过本地路径添加</summary>
      <div className="space-y-3 mt-3">
        <p className="text-xs text-muted-foreground">先授权文件夹，再按路径添加。完整路径只用于匹配所选目录；文件夹选择窗口中也可以粘贴本地路径。</p>
        <button className="border rounded-lg px-3 py-2 disabled:opacity-50" disabled={props.locked} onClick={props.onAuthorize}>授权文件夹</button>
        {props.rootName && <p className="text-sm" role="status">已授权目录：{props.rootName}</p>}
        <label className="block text-sm">授权目录完整路径（使用绝对路径时填写）
          <input className="w-full mt-1 border rounded-lg p-2 bg-background" placeholder="C:\笔记" disabled={props.locked} value={props.absoluteRoot} onChange={event => props.onRootChange(event.target.value)} />
        </label>
        <label className="block text-sm">文件或文件夹路径（每行一条）
          <textarea className="w-full mt-1 border rounded-lg p-2 bg-background font-mono text-xs" rows={4} placeholder={'文章\\第一篇.md\n文章\\第二篇.md\n学习笔记'} disabled={props.locked} value={props.pathText} onChange={event => props.onPathsChange(event.target.value)} />
        </label>
        <p className="text-xs text-muted-foreground">支持相对路径和授权目录内的完整路径。目录递归添加 Markdown/HTML；留空添加整个授权目录，配套图片自动参与转换。</p>
        <button className="border rounded-lg px-3 py-2 disabled:opacity-50" disabled={props.locked || !props.rootName} onClick={props.onAddPaths}>按路径添加</button>
      </div>
    </details>
    {props.items.length > 0 && <>
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="font-medium">待上传文档（{props.items.length}）</h2>
        <button className="text-sm underline disabled:opacity-50" disabled={props.locked} onClick={() => props.onSelectAll(true)}>全选文档</button>
        <button className="text-sm underline disabled:opacity-50" disabled={props.locked} onClick={() => props.onSelectAll(false)}>取消全选文档</button>
        <button className="text-sm underline disabled:opacity-50" disabled={props.locked} onClick={props.onClear}>清空列表</button>
      </div>
      <div className="overflow-auto max-h-96">
        <table className="w-full text-sm text-left"><thead><tr className="border-b"><th className="p-2">选择</th><th className="p-2">文件 / 标题</th><th className="p-2">状态与结果</th><th className="p-2">预览</th></tr></thead>
          <tbody>{props.items.map(item => <tr key={item.path} className="border-b align-top">
            <td className="p-2"><input type="checkbox" aria-label={`选择文档 ${item.path}`} disabled={props.locked} checked={item.selected} onChange={event => props.onToggle(item.path, event.target.checked)} /></td>
            <td className="p-2 break-all"><p>{item.path}</p><p className="text-xs text-muted-foreground">{item.title}</p></td>
            <td className="p-2"><span>{labels[item.status]}</span>{renderResults(item)}</td>
            <td className="p-2"><button className="underline disabled:opacity-50" aria-label={`预览 ${item.path}`} disabled={props.locked} onClick={() => props.onPreview(item.path)}>预览</button></td>
          </tr>)}</tbody>
        </table>
      </div>
      <div className="flex gap-3 items-center flex-wrap">
        <button className="rounded-lg bg-primary text-primary-foreground px-4 py-2 disabled:opacity-50" disabled={props.locked || !eligible} onClick={props.onStart}>批量同步 {eligible} 份文档</button>
        {props.running && <button className="border rounded-lg px-3 py-2 disabled:opacity-50" disabled={props.stopRequested} onClick={props.onStop}>{props.stopRequested ? '将在当前项完成后停止' : '完成当前项后停止'}</button>}
      </div>
      <p className="text-xs text-muted-foreground">每份文档单独上传，依次处理以保护剪贴板。已成功平台不会重复上传；结果待确认或目标已创建后失败的项目，请先检查历史或文档。关闭此页会停止启动后续项，当前后台任务仍会继续。</p>
    </>}
    {props.previousItems.length > 0 && <details>
      <summary className="text-sm cursor-pointer">上次批量结果（{props.previousItems.length} 份）</summary>
      <ul className="text-sm space-y-2 mt-2">{props.previousItems.map(item => <li key={item.path}><span>{item.title}：{labels[item.status === 'syncing' ? 'unknown' : item.status]}</span>{renderResults(item)}</li>)}</ul>
      <p className="text-xs text-muted-foreground mt-2">仅保留结果摘要。重新选择源文件后才可再次上传；不会自动恢复队列。</p>
    </details>}
  </section>
}
