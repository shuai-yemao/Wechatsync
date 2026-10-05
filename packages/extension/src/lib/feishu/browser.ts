import { createdDocument, feishuOrigin, prepareFeishuHtml, verifyFeishuSaved, type PreparedContent } from './protocol'

const permissions = ['debugger', 'clipboardRead', 'clipboardWrite']
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
export async function requireFeishuPermissions(): Promise<void> {
  if (!await chrome.permissions.contains({ permissions })) throw new Error('请在同步按钮处授权飞书所需的临时调试与剪贴板权限')
}

export async function selectFeishuTab(): Promise<{ tabId: number; origin: string }> {
  const tabs = (await chrome.tabs.query({})).filter(tab => typeof tab.id === 'number' && tab.url && feishuOrigin(tab.url))
  const active = tabs.filter(tab => tab.active)
  const candidates = active.length === 1 ? active : tabs
  if (!candidates.length) throw new Error('请先在浏览器打开并登录飞书云文档')
  if (new Set(candidates.map(tab => feishuOrigin(tab.url!))).size > 1) throw new Error('检测到多个飞书租户，请只保留一个活动的飞书租户标签页后重试')
  const tab = candidates[0]
  return { tabId: tab.id!, origin: feishuOrigin(tab.url!)! }
}

async function request(tabId: number, origin: string, path: string, form?: Record<string, string>): Promise<any> {
  let csrf = ''
  for (const name of ['_csrf_token', 'swp_csrf_token']) {
    const cookie = await chrome.cookies.get({ url: origin, name })
    if (cookie?.value) { csrf = cookie.value; break }
  }
  if (form && !csrf) throw new Error('未找到飞书登录会话的 CSRF 信息，请刷新已登录的云文档页面')
  const [execution] = await chrome.scripting.executeScript({
    target: { tabId },
    func: async (expectedOrigin: string, apiPath: string, token: string, fields?: Record<string, string>) => {
      if (location.origin !== expectedOrigin) throw new Error('飞书标签页已导航，停止请求')
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000)
      try {
        const headers: Record<string, string> = { Accept: 'application/json', 'doc-biz': 'Lark' }
        if (token) headers['x-csrftoken'] = token
        if (fields) headers['Content-Type'] = 'application/x-www-form-urlencoded;charset=UTF-8'
        const response = await fetch(apiPath, { method: fields ? 'POST' : 'GET', credentials: 'include', redirect: 'error', headers, body: fields ? new URLSearchParams(fields).toString() : undefined, signal: controller.signal })
        if (!response.ok) throw new Error(`飞书请求失败 HTTP ${response.status}`)
        const json = await response.json()
        if (json.code !== 0) throw new Error(`飞书请求失败 code=${String(json.code)} ${String(json.msg ?? '').slice(0, 160)}`)
        return json
      } finally { clearTimeout(timer) }
    },
    args: [origin, path, csrf, form],
  })
  if (!execution?.result) throw new Error('飞书页面没有返回请求结果')
  return execution.result
}

export async function createFeishuDocument(tabId: number, origin: string, title: string): Promise<{ token: string; url: string }> {
  const response = await request(tabId, origin, '/space/api/explorer/v2/create/object/', {
    parent_token: '', type: '22', name: title.slice(0, 500), time_zone: 'Asia/Shanghai', source: '0', ua_type: 'Web', scene: 'space_create',
  })
  return createdDocument(response, origin)
}

async function readSaved(tabId: number, origin: string, token: string): Promise<Record<string, any>> {
  let page = (await request(tabId, origin, `/space/api/docx/pages/client_vars?id=${encodeURIComponent(token)}&mode=1&limit=239`)).data
  if (!page || typeof page.block_map !== 'object') throw new Error('飞书回读协议发生变化，没有正文块树')
  const merged: Record<string, any> = { ...page, block_map: { ...page.block_map }, skip_blocks: [] }
  const skipped = new Set<string>((page.skip_blocks ?? []).map(String))
  const merge = (next: any) => {
    for (const [id, value] of Object.entries(next.block_map ?? {})) {
      const old = merged.block_map[id]
      // Keep root children from all pages, rather than dropping earlier siblings.
      const entry: any = value
      if (old && Array.isArray(old.children) && Array.isArray(entry.children)) merged.block_map[id] = { ...entry, children: [...new Set([...old.children, ...entry.children])] }
      else merged.block_map[id] = entry
    }
    for (const id of next.skip_blocks ?? []) skipped.add(String(id))
  }
  const cursors = new Set<string>()
  for (let count = 0; page.has_more && count < 20; count++) {
    if (typeof page.cursor !== 'string' || !page.cursor || cursors.has(page.cursor)) throw new Error('飞书分页协议无法完整读取，不能确认上传成功')
    cursors.add(page.cursor)
    const next = (await request(tabId, origin, `/space/api/docx/pages/client_vars?id=${encodeURIComponent(token)}&mode=1&limit=239&cursor=${encodeURIComponent(page.cursor)}`)).data
    if (!Object.keys(next?.block_map ?? {}).some(id => !merged.block_map[id])) throw new Error('飞书分页没有返回新的正文块')
    merge(next); page = next
  }
  if (page.has_more) throw new Error('飞书正文分页超过回验上限')
  for (const id of skipped) {
    if (skipped.size > 200) throw new Error('飞书子树数量超过回验上限')
    let cursor = '', complete = false
    for (let count = 0; count < 20; count++) {
      const next = (await request(tabId, origin, `/space/api/docx/pages/client_vars?id=${encodeURIComponent(token)}&mode=4&block_id=${encodeURIComponent(id)}&limit=239${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)).data
      if (!next?.block_map) throw new Error('飞书缺失子树无法读取')
      merge(next)
      if (!next.has_more) { complete = true; break }
      if (!next.cursor || next.cursor === cursor) break
      cursor = next.cursor
    }
    if (!complete) throw new Error('飞书子树分页尚未完整读取')
  }
  merged.has_more = false
  return merged
}

/** Attach only to the new tab; backup/restore clipboard in its isolated world. */
export async function pasteAndVerifyFeishu(tabId: number, origin: string, token: string, content: PreparedContent): Promise<void> {
  const target = { tabId }
  const pathname = `/docx/${token}`
  let attached = false, clipboardSaved = false
  try {
    await chrome.debugger.attach(target, '1.3'); attached = true
    await chrome.debugger.sendCommand(target, 'Emulation.setFocusEmulationEnabled', { enabled: true })
    await chrome.tabs.update(tabId, { active: true })
    for (let attempt = 0; attempt < 40; attempt++) {
      const tab = await chrome.tabs.get(tabId)
      const url = new URL(tab.pendingUrl || tab.url || `${origin}${pathname}`)
      if (url.origin !== origin || url.pathname !== pathname) throw new Error('新文档页面已导航，停止输入')
      if (tab.status === 'complete') break
      if (attempt === 39) throw new Error('新文档页面加载超时')
      await sleep(500)
    }
    const before = await readSaved(tabId, origin, token)
    const blank = verifyFeishuSaved(before, { html: '', text: '', codes: [], links: [], imageCount: 0 })
    if (!blank.ok) throw new Error('新文档已经出现正文或无法确认空白状态，停止粘贴以避免重复内容')
    const blankBlockId = Object.keys(before.block_map).find(id => {
      const entry = before.block_map[id]
      return (entry.data?.type ?? entry.type) === 'text'
    }) || ''
    let point: { x: number; y: number } | null = null
    for (let attempt = 0; attempt < 40; attempt++) {
      const [result] = await chrome.scripting.executeScript({ target, func: (expectedOrigin: string, expectedPath: string, blockId: string) => {
        if (location.origin !== expectedOrigin || location.pathname !== expectedPath) throw new Error('新文档页面已导航，停止输入')
        const block = blockId ? document.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(blockId)}"],[data-record-id="${CSS.escape(blockId)}"],[data-node-id="${CSS.escape(blockId)}"]`) : null
        const candidates = block ? [block] : [...document.querySelectorAll<HTMLElement>('[contenteditable="true"]')].sort((a, b) => {
          const ar = a.getBoundingClientRect(), br = b.getBoundingClientRect()
          return br.width * br.height - ar.width * ar.height
        })
        const editor = candidates.find(el => {
          const rect = el.getBoundingClientRect()
          return rect.width > 0 && rect.height > 0 && (el.isContentEditable || !!el.querySelector('[contenteditable="true"]')) && !el.closest('[class*="title"], [class*="Title"]')
        })
        if (!editor) return null
        editor.scrollIntoView({ block: 'center' })
        const rect = editor.getBoundingClientRect()
        return { x: rect.left + Math.min(rect.width / 2, 20), y: rect.top + Math.min(rect.height / 2, 12) }
      }, args: [origin, pathname, blankBlockId] })
      point = result?.result ?? null
      if (point) break
      await sleep(500)
    }
    if (!point) throw new Error('没有找到飞书新文档正文编辑器，页面协议可能发生变化')
    const [copyResult] = await chrome.scripting.executeScript({ target, func: async (expectedOrigin: string, expectedPath: string, html: string, text: string) => {
      if (location.origin !== expectedOrigin || location.pathname !== expectedPath) throw new Error('新文档已导航')
      const scope = globalThis as any
      const backup = await navigator.clipboard.read()
      const saved: Record<string, Blob>[] = []
      for (const item of backup) {
        const data: Record<string, Blob> = {}
        for (const type of item.types) {
          if (!['text/plain', 'text/html', 'image/png'].includes(type)) throw new Error('剪贴板包含无法恢复的格式，请先清空或复制普通文本后重试')
          data[type] = await item.getType(type)
        }
        saved.push(data)
      }
      scope.__wechatsyncFeishuClipboard = saved
      const textarea = document.createElement('textarea')
      textarea.value = text
      textarea.style.cssText = 'position:fixed;left:-10000px;top:0'
      const copy = (event: ClipboardEvent) => {
        event.preventDefault()
        event.clipboardData?.setData('text/html', html)
        event.clipboardData?.setData('text/plain', text)
      }
      try {
        document.body.appendChild(textarea); textarea.focus(); textarea.select()
        document.addEventListener('copy', copy)
        if (!document.execCommand('copy')) throw new Error('无法写入剪贴板')
        const read = await navigator.clipboard.read()
        const item = read.find(item => item.types.includes('text/html'))
        if (!item) throw new Error('剪贴板没有 HTML 正文，停止输入')
        return await (await item.getType('text/html')).text()
      } finally { document.removeEventListener('copy', copy); textarea.remove() }
    }, args: [origin, pathname, content.html, content.text] })
    clipboardSaved = true
    if (typeof copyResult?.result !== 'string') throw new Error('飞书剪贴板准备失败')
    const copied = prepareFeishuHtml(copyResult.result)
    if (copied.html !== content.html) throw new Error('剪贴板 HTML 回读与正文不一致，停止输入')
    for (const type of ['mousePressed', 'mouseReleased']) await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', clickCount: 1 })
    const [paste] = await chrome.scripting.executeScript({ target, func: (expectedOrigin: string, expectedPath: string) => {
      if (location.origin !== expectedOrigin || location.pathname !== expectedPath) throw new Error('新文档已导航，停止粘贴')
      return document.execCommand('paste')
    }, args: [origin, pathname] })
    if (!paste?.result) throw new Error('飞书原生粘贴没有执行')
    let reason = '尚未保存'
    for (let attempt = 0; attempt < 20; attempt++) {
      await sleep(3000)
      const verified = verifyFeishuSaved(await readSaved(tabId, origin, token), content)
      if (verified.ok) return
      reason = verified.reason
    }
    throw new Error(`服务端回验失败：${reason}。已创建文档保留供检查，请勿直接重试以免创建重复文档`)
  } finally {
    // The copy script may fail after storing the backup. Always check it, even
    // when executeScript rejected before it could set clipboardSaved here.
    if (attached || clipboardSaved) {
      try {
        await chrome.scripting.executeScript({ target, func: async () => {
          const scope = globalThis as any, saved = scope.__wechatsyncFeishuClipboard as Record<string, Blob>[] | undefined
          if (saved) {
            try {
              if (saved.length) await navigator.clipboard.write(saved.map(data => new ClipboardItem(data)))
              else await navigator.clipboard.writeText('')
            } finally { delete scope.__wechatsyncFeishuClipboard }
          }
        } })
      } finally {
        if (attached) await chrome.debugger.detach(target).catch(() => {})
      }
    }
  }
}
