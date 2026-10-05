import { createLogger } from './logger'

const logger = createLogger('RemoteConfig')

const CONFIG_URL = 'https://wpics.oss-cn-shanghai.aliyuncs.com/wechatsync-config.json'
const STORAGE_KEY_BANNERS = 'remoteBanners'
const STORAGE_KEY_LAST_FETCH = 'remoteBanners_lastFetch'
const STORAGE_KEY_LAST_ATTEMPT = 'remoteBanners_lastAttempt'
const STORAGE_KEY_STATUS = 'remoteConfigStatus'
const STORAGE_KEY_DISMISSED = 'dismissedBanners'
const CHECK_INTERVAL_HOURS = 6

export interface RemoteBanner {
  id: string
  title: string
  description?: string
  action?: { text: string; url: string }
  icon?: string
  style?: 'info' | 'promo' | 'warning'
  dismissible?: boolean
  startDate?: string
  endDate?: string
  targetVersion?: string
  priority?: number
}

interface RemoteConfig {
  banners?: RemoteBanner[]
}

// ── Version matching ──

function matchVersion(constraint: string, current: string): boolean {
  const m = constraint.match(/^>=(.+)$/)
  if (!m) return constraint === current
  const req = m[1].split('.').map(Number)
  const cur = current.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if ((cur[i] || 0) > (req[i] || 0)) return true
    if ((cur[i] || 0) < (req[i] || 0)) return false
  }
  return true
}

function isDateValid(banner: RemoteBanner): boolean {
  const now = Date.now()
  if (banner.startDate && new Date(banner.startDate).getTime() > now) return false
  if (banner.endDate && new Date(banner.endDate).getTime() < now) return false
  return true
}

// ── Fetch & cache ──

let pendingFetch: Promise<void> | null = null

export function fetchRemoteConfig(): Promise<void> {
  // Installation and worker activation can request the same optional config together.
  if (pendingFetch) return pendingFetch
  pendingFetch = performFetch().finally(() => { pendingFetch = null })
  return pendingFetch
}

async function performFetch(): Promise<void> {
  const attemptedAt = Date.now()
  try {
    // Record attempts, including failures, to avoid retrying on every worker wake-up.
    await chrome.storage.local.set({ [STORAGE_KEY_LAST_ATTEMPT]: attemptedAt })
    const response = await fetch(CONFIG_URL, {
      cache: 'no-cache',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) {
      await chrome.storage.local.set({
        [STORAGE_KEY_STATUS]: {
          state: response.status === 404 ? 'unavailable' : 'error',
          httpStatus: response.status,
          attemptedAt,
        },
      })
      // A missing announcement file is optional; keep cached banners and retry later.
      if (response.status === 404) logger.debug('Announcement config unavailable; using cache')
      else logger.warn('Config fetch failed:', response.status)
      return
    }
    const config: RemoteConfig = await response.json()
    const version = chrome.runtime.getManifest().version

    const validBanners = (config.banners || [])
      .filter(b => isDateValid(b))
      .filter(b => !b.targetVersion || matchVersion(b.targetVersion, version))
      .sort((a, b) => (b.priority || 0) - (a.priority || 0))

    await chrome.storage.local.set({
      [STORAGE_KEY_BANNERS]: validBanners,
      [STORAGE_KEY_LAST_FETCH]: Date.now(),
      [STORAGE_KEY_STATUS]: { state: 'ok', attemptedAt },
    })
    logger.debug('Config updated:', validBanners.length, 'banners')
  } catch (e) {
    await chrome.storage.local.set({
      [STORAGE_KEY_STATUS]: { state: 'error', attemptedAt, error: e instanceof Error ? e.message : String(e) },
    }).catch(() => {})
    logger.warn('Failed to fetch config:', e)
  }
}

export async function fetchConfigIfNeeded(): Promise<void> {
  try {
    const r = await chrome.storage.local.get([STORAGE_KEY_LAST_ATTEMPT, STORAGE_KEY_LAST_FETCH])
    const last = (r[STORAGE_KEY_LAST_ATTEMPT] || r[STORAGE_KEY_LAST_FETCH]) as number | undefined
    if (!last || Date.now() - last >= CHECK_INTERVAL_HOURS * 60 * 60 * 1000) {
      await fetchRemoteConfig()
    }
  } catch {
    await fetchRemoteConfig()
  }
}

// ── Read active banner (for UI) ──

export async function getActiveBanner(): Promise<RemoteBanner | null> {
  try {
    const r = await chrome.storage.local.get([STORAGE_KEY_BANNERS, STORAGE_KEY_DISMISSED])
    const banners = (r[STORAGE_KEY_BANNERS] as RemoteBanner[] | undefined) || []
    const dismissed = (r[STORAGE_KEY_DISMISSED] as string[] | undefined) || []
    const dismissedSet = new Set(dismissed)

    // Re-check dates (config may have been cached hours ago)
    return banners.find(b => !dismissedSet.has(b.id) && isDateValid(b)) || null
  } catch {
    return null
  }
}

export async function dismissBanner(id: string): Promise<void> {
  try {
    const r = await chrome.storage.local.get(STORAGE_KEY_DISMISSED)
    const ids = (r[STORAGE_KEY_DISMISSED] as string[] | undefined) || []
    if (!ids.includes(id)) {
      await chrome.storage.local.set({ [STORAGE_KEY_DISMISSED]: [...ids, id] })
    }
  } catch {
    // ignore
  }
}
