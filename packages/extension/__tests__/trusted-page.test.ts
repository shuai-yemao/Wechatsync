import { describe, expect, it, vi } from 'vitest'
import { isTrustedExtensionPage } from '../src/lib/trusted-page'

describe('sensitive extension message boundary', () => {
  const extensionId = 'abcdefghijklmnopabcdefghijklmnop'
  function sender(url: string, id = extensionId) { return { url, id } }
  it('accepts only packaged UI pages from the same extension', () => {
    Object.assign(chrome.runtime, { id: extensionId })
    vi.mocked(chrome.runtime.getURL).mockImplementation(path => `chrome-extension://${extensionId}${path.startsWith('/') ? path : '/' + path}`)
    expect(isTrustedExtensionPage(sender(`chrome-extension://${extensionId}/src/local-import/index.html`))).toBe(true)
    expect(isTrustedExtensionPage(sender(`chrome-extension://${extensionId}/src/popup/index.html#/`))).toBe(true)
    expect(isTrustedExtensionPage(sender('https://example.com/src/local-import/index.html'))).toBe(false)
    expect(isTrustedExtensionPage(sender('file:///src/local-import/index.html'))).toBe(false)
    expect(isTrustedExtensionPage(sender('chrome-extension://other/src/local-import/index.html'))).toBe(false)
    expect(isTrustedExtensionPage(sender(`chrome-extension://${extensionId}/src/local-import/index.html`, 'other'))).toBe(false)
    expect(isTrustedExtensionPage(sender(`chrome-extension://${extensionId}/src/preprocessor/index.html`))).toBe(false)
    expect(isTrustedExtensionPage(undefined)).toBe(false)
  })
})
