import { afterEach, describe, expect, it, vi } from 'vitest'
import { WeiboAdapter } from '../weibo'
import type { RuntimeInterface } from '../../../runtime/interface'

afterEach(() => vi.restoreAllMocks())

async function adapterFor(response: Response) {
  const fetcher = vi.fn(async () => response.clone())
  const adapter = new WeiboAdapter()
  await adapter.init({ type: 'node', fetch: fetcher } as unknown as RuntimeInterface)
  return { adapter, fetcher }
}

describe('Weibo startup authentication checks', () => {
  it('returns an actionable auth result instead of a console error for guest HTML', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { adapter } = await adapterFor(new Response('<html>Login to Weibo</html>'))
    const auth = await adapter.checkAuth()
    expect(auth.isAuthenticated).toBe(false)
    expect(auth.error).toContain('登录微博')
    expect(error).not.toHaveBeenCalled()
  })

  it('keeps HTTP failures distinct from logged-out state', async () => {
    const { adapter } = await adapterFor(new Response('<html>Unavailable</html>', { status: 503 }))
    expect(await adapter.checkAuth()).toMatchObject({ isAuthenticated: false, error: expect.stringContaining('HTTP 503') })
  })

  it('accepts an explicit unauthorized response as logged out', async () => {
    const { adapter } = await adapterFor(new Response('', { status: 401 }))
    expect(await adapter.checkAuth()).toEqual({ isAuthenticated: false })
  })

  it('reports malformed embedded configuration without throwing from checkAuth', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { adapter } = await adapterFor(new Response("config: JSON.parse('{broken}')"))
    expect(await adapter.checkAuth()).toMatchObject({ isAuthenticated: false, error: expect.stringContaining('格式') })
    expect(error).not.toHaveBeenCalled()
  })

  it('parses an authenticated editor and refreshes a previously cached session', async () => {
    const { adapter, fetcher } = await adapterFor(new Response(`config: JSON.parse('{"uid":123,"nick":"测试","avatar_large":"https://example.com/avatar.png"}')`))
    expect(await adapter.checkAuth()).toMatchObject({ isAuthenticated: true, userId: '123', username: '测试' })
    fetcher.mockResolvedValueOnce(new Response('', { status: 401 }))
    expect(await adapter.checkAuth()).toEqual({ isAuthenticated: false })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})
