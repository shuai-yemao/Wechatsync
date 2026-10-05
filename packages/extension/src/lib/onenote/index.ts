import { htmlToMarkdownNative } from '../../../../core/src/lib/turndown'
import type { OneNotePageContent } from './reader'

export { authorizeOneNote, disconnectOneNote, oneNoteRedirectUri } from './auth'
export { readOneNotePage, validateOneNoteSource } from './reader'
export type { OneNotePageContent } from './reader'

/** Run in the extension UI so native DOM conversion keeps rich blocks. */
export function prepareOneNoteImport(page: OneNotePageContent): OneNotePageContent & { markdown: string } {
  if (typeof document === 'undefined') throw new Error('OneNote Markdown 转换必须在扩展预览页面执行。')
  const container = document.createElement('div')
  container.innerHTML = page.html
  const blocks = new Map<string, string>()
  for (const pre of Array.from(container.querySelectorAll('pre'))) {
    // textContent preserves spaces even if the conversion runs in a hidden preview.
    const clone = pre.cloneNode(true) as HTMLElement
    clone.querySelectorAll('br').forEach(br => br.replaceWith(document.createTextNode('\n')))
    const lines = clone.querySelectorAll('code')
    const text = (lines.length > 1 ? Array.from(lines).map(line => line.textContent || '').join('\n') : clone.textContent || '').replace(/\r\n?/g, '\n')
    const backticks = text.match(/`+/g)?.map(value => value.length) || []
    const fence = '`'.repeat(Math.max(3, ...backticks.map(length => length + 1)))
    const language = pre.getAttribute('data-lang') || pre.querySelector('code')?.className.match(/language-([a-zA-Z0-9+#._-]+)/)?.[1] || ''
    const safeLanguage = /^[a-zA-Z0-9+#._-]{1,32}$/.test(language) ? language : ''
    const marker = `ONENOTECODE${crypto.randomUUID().replace(/-/g, '')}`
    blocks.set(marker, `${fence}${safeLanguage}\n${text}${text.endsWith('\n') ? '' : '\n'}${fence}`)
    const placeholder = document.createElement('p')
    placeholder.textContent = marker
    pre.replaceWith(placeholder)
  }
  let markdown = htmlToMarkdownNative(container.innerHTML)
  for (const [marker, block] of blocks) markdown = markdown.replace(marker, block)
  return { ...page, markdown }
}
