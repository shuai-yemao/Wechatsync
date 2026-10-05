/** Sensitive browser capabilities are available only to packaged extension pages. */
export function isTrustedExtensionPage(sender: chrome.runtime.MessageSender | undefined): boolean {
  if (!sender || sender.id !== chrome.runtime.id || !sender.url) return false
  try {
    const url = new URL(sender.url)
    const root = new URL(chrome.runtime.getURL('/'))
    return url.protocol === 'chrome-extension:' && url.host === root.host && [
      '/src/local-import/index.html', '/src/popup/index.html',
      '/src/editor/index.html', '/src/sync-dialog/index.html',
    ].includes(url.pathname)
  } catch { return false }
}
