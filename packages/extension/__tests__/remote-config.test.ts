import { afterEach, describe, expect, it, vi } from 'vitest'
import { chromeMock, mockStorage } from '../vitest.setup'
import { fetchConfigIfNeeded, fetchRemoteConfig } from '../src/lib/remote-config'

const logger = vi.hoisted(() => ({ debug: vi.fn(), warn: vi.fn() }))
vi.mock('../src/lib/logger', () => ({ createLogger: () => logger }))
Object.assign(chromeMock.runtime, { getManifest: () => ({ version: '2.0.9' }) })
afterEach(() => vi.unstubAllGlobals())

describe('optional announcement configuration failures', () => {
  it('treats HTTP 404 as unavailable, preserves cached banners and backs off', async () => {
    mockStorage.remoteBanners = [{ id: 'cached', title: 'Cached' }]
    const fetcher = vi.fn(async () => new Response('', { status: 404 }))
    vi.stubGlobal('fetch', fetcher)
    await fetchConfigIfNeeded()
    await fetchConfigIfNeeded()
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(mockStorage.remoteBanners[0].id).toBe('cached')
    expect(mockStorage.remoteConfigStatus).toMatchObject({ state: 'unavailable', httpStatus: 404 })
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('deduplicates simultaneous install and startup checks', async () => {
    const fetcher = vi.fn(async () => new Response('', { status: 404 }))
    vi.stubGlobal('fetch', fetcher)
    await Promise.all([fetchRemoteConfig(), fetchConfigIfNeeded(), fetchRemoteConfig()])
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('retries after the six-hour interval and records recovery', async () => {
    mockStorage.remoteBanners_lastAttempt = Date.now() - 6 * 60 * 60 * 1000 - 1
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ banners: [{ id: 'new', title: 'New' }] })))
    await fetchConfigIfNeeded()
    expect(mockStorage.remoteBanners[0].id).toBe('new')
    expect(mockStorage.remoteConfigStatus).toMatchObject({ state: 'ok' })
    expect(mockStorage.remoteBanners_lastFetch).toBeGreaterThan(0)
  })

  it('backs off on server errors while preserving diagnostic status', async () => {
    const fetcher = vi.fn(async () => new Response('', { status: 503 }))
    vi.stubGlobal('fetch', fetcher)
    await fetchConfigIfNeeded()
    await fetchConfigIfNeeded()
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(mockStorage.remoteConfigStatus).toMatchObject({ state: 'error', httpStatus: 503 })
    expect(logger.warn).toHaveBeenCalled()
  })

  it('retains cached banners when the server returns invalid JSON', async () => {
    mockStorage.remoteBanners = [{ id: 'cached', title: 'Cached' }]
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>Unavailable</html>')))
    await fetchRemoteConfig()
    expect(mockStorage.remoteBanners[0].id).toBe('cached')
    expect(mockStorage.remoteConfigStatus).toMatchObject({ state: 'error' })
  })
})
