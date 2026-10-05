import type { Article, AuthResult, PlatformAdapter, PlatformMeta, PublishOptions, RuntimeInterface, SyncResult } from '@wechatsync/core'
import { marked } from 'marked'
import { prepareFeishuHtml } from '../lib/feishu/protocol'
import { createFeishuDocument, pasteAndVerifyFeishu, requireFeishuPermissions, selectFeishuTab } from '../lib/feishu/browser'

/** Browser session integration. Feishu's private editor protocol may change;
 * success requires a server-side content readback, not a successful create API. */
export class FeishuAdapter implements PlatformAdapter {
  readonly meta: PlatformMeta = {
    id: 'feishu', name: '飞书文档', icon: 'https://www.feishu.cn/favicon.ico',
    homepage: 'https://www.feishu.cn', capabilities: ['article', 'image_upload'],
  }
  readonly preprocessConfig = { outputFormat: 'html' as const, removeLinks: false, processCodeBlocks: false }
  private publishing = false
  async init(_runtime: RuntimeInterface): Promise<void> {}
  async checkAuth(): Promise<AuthResult> {
    try {
      const { origin } = await selectFeishuTab()
      const cookies = await chrome.cookies.getAll({ url: origin })
      if (!cookies.some(cookie => /^(session|sl_session|session_id|sso_session)$/i.test(cookie.name) && cookie.value)) return { isAuthenticated: false, error: '请登录飞书云文档后刷新平台列表' }
      return { isAuthenticated: true, username: new URL(origin).hostname }
    } catch (error) { return { isAuthenticated: false, error: error instanceof Error ? error.message : String(error) } }
  }
  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    if (this.publishing) return { platform: 'feishu', success: false, error: '已有飞书同步任务正在使用剪贴板，请等待完成', timestamp: Date.now() }
    this.publishing = true
    let created: { token: string; url: string } | undefined
    try {
      await requireFeishuPermissions()
      const content = prepareFeishuHtml(article.html || await marked.parse(article.markdown || ''))
      const selected = await selectFeishuTab()
      created = await createFeishuDocument(selected.tabId, selected.origin, article.title || '导入文档')
      const tab = await chrome.tabs.create({ url: created.url, active: true })
      if (typeof tab.id !== 'number') throw new Error('无法打开新飞书文档')
      await pasteAndVerifyFeishu(tab.id, selected.origin, created.token, content)
      options?.onImageProgress?.(content.imageCount, content.imageCount)
      return { platform: 'feishu', success: true, postId: created.token, postUrl: created.url, draftOnly: false, message: '正文、代码块、图片及链接已通过服务端保存回验', timestamp: Date.now() }
    } catch (error) {
      return { platform: 'feishu', success: false, postId: created?.token, postUrl: created?.url, error: error instanceof Error ? error.message : String(error), message: created ? '已创建文档保留供检查；不会自动创建第二份文档' : undefined, timestamp: Date.now() }
    } finally { this.publishing = false }
  }
}
