/** Browser-only delegated OAuth. No application secret or refresh token is stored. */
const SCOPE = 'https://graph.microsoft.com/Notes.Read'
const AUTH_ROOT = 'https://login.microsoftonline.com/common/oauth2/v2.0'
const CACHE_KEY = 'onenoteDelegatedSession'
const pending = new Map<string, Promise<string>>()
let loginGeneration = 0

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function oneNoteRedirectUri(): string {
  return chrome.identity.getRedirectURL('onenote')
}

export async function disconnectOneNote(): Promise<void> {
  loginGeneration++
  await chrome.storage.session.remove(CACHE_KEY)
}

/** Call only from a trusted extension page message in the service worker. */
export async function authorizeOneNote(clientId: string): Promise<string> {
  const id = clientId.trim()
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error('请先填写 Microsoft Entra 应用 client ID，并注册扩展重定向 URI（SPA）；只需 Notes.Read 委托权限，无需密钥。')
  }
  if (!chrome.identity?.launchWebAuthFlow || !chrome.storage.session) {
    throw new Error('当前浏览器未提供 identity 或 session storage，无法安全授权 OneNote。')
  }
  const cached = (await chrome.storage.session.get(CACHE_KEY))[CACHE_KEY]
  if (cached?.clientId === id && typeof cached.accessToken === 'string' && cached.expiresAt > Date.now() + 60_000) {
    return cached.accessToken
  }
  const existing = pending.get(id)
  if (existing) return existing
  await chrome.storage.session.remove(CACHE_KEY)
  const request = obtainToken(id, loginGeneration)
  pending.set(id, request)
  try { return await request } finally { pending.delete(id) }
}

async function obtainToken(clientId: string, generation: number): Promise<string> {
  const redirectUri = oneNoteRedirectUri()
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)))
  const state = base64url(crypto.getRandomValues(new Uint8Array(24)))
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  const authorize = new URL(`${AUTH_ROOT}/authorize`)
  authorize.search = new URLSearchParams({
    client_id: clientId, response_type: 'code', redirect_uri: redirectUri,
    response_mode: 'query', scope: SCOPE, state,
    code_challenge: base64url(new Uint8Array(digest)), code_challenge_method: 'S256',
    prompt: 'select_account',
  }).toString()
  let callback: string | undefined
  try { callback = await chrome.identity.launchWebAuthFlow({ url: authorize.href, interactive: true }) }
  catch { throw new Error('OneNote 登录被取消或无法完成，请重新授权。') }
  if (!callback) throw new Error('OneNote 授权未返回结果。')
  const result = new URL(callback)
  const expected = new URL(redirectUri)
  if (result.origin !== expected.origin || result.pathname !== expected.pathname || result.searchParams.get('state') !== state) {
    throw new Error('OneNote 授权响应校验失败，请重新授权。')
  }
  if (result.searchParams.has('error')) throw new Error('OneNote 授权被拒绝；请检查账户访问权限及 Entra 应用配置。')
  const code = result.searchParams.get('code')
  if (!code) throw new Error('OneNote 授权缺少 authorization code。')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30_000)
  try {
    const response = await fetch(`${AUTH_ROOT}/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, grant_type: 'authorization_code', code,
        redirect_uri: redirectUri, code_verifier: verifier, scope: SCOPE }),
      credentials: 'omit', redirect: 'error', signal: controller.signal,
    })
    if (!response.ok) throw new Error('OneNote token 换取失败；请核对 SPA 重定向 URI、账户类型与 Notes.Read 委托许可。')
    const token = await response.json()
    if (typeof token.access_token !== 'string' || !Number.isFinite(token.expires_in) || token.expires_in <= 0 || token.token_type?.toLowerCase() !== 'bearer') {
      throw new Error('OneNote token 响应无效。')
    }
    if (generation !== loginGeneration) throw new Error('OneNote 登录已断开，请重新授权。')
    await chrome.storage.session.set({ [CACHE_KEY]: { clientId, accessToken: token.access_token,
      expiresAt: Date.now() + token.expires_in * 1000 } })
    return token.access_token
  } finally { clearTimeout(timer) }
}
