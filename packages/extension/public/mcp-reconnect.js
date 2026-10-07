// Local setup recovery when an old worker cannot answer runtime messages.
// Navigating to this packaged page is an explicit request to reconnect localhost.
(async () => {
  try {
    const { mcpToken } = await chrome.storage.local.get('mcpToken')
    if (!mcpToken) throw new Error('请先在插件设置中启用 MCP，生成本机连接 Token。')
    await chrome.storage.local.set({ mcpEnabled: true, mcpServerUrl: 'ws://127.0.0.1:9527' })
    chrome.runtime.reload()
  } catch (error) {
    document.getElementById('status').textContent = error.message || '恢复连接失败'
  }
})()
