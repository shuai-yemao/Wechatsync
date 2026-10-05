import { describe, expect, it, vi } from 'vitest'
import manifest from '../manifest.json'
import { requestFeishuClipboardPermissions } from '../src/lib/feishu/permissions'

describe('Chrome Feishu capability declarations', () => {
  it('declares debugger as required because Chrome rejects it as optional', () => {
    expect(manifest.permissions).toContain('debugger')
    expect(manifest.optional_permissions).not.toContain('debugger')
    expect(manifest.optional_permissions).toEqual(['clipboardRead', 'clipboardWrite'])
  })
  it('requests only optional clipboard capabilities from the user gesture', async () => {
    const request = vi.fn(async () => false)
    Object.assign(chrome, { permissions: { request } })
    expect(await requestFeishuClipboardPermissions()).toBe(false)
    expect(request).toHaveBeenCalledWith({ permissions: ['clipboardRead', 'clipboardWrite'] })
  })
})
