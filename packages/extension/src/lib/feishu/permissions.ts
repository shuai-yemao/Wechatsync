/** Chrome forbids optional debugger permission. Clipboard access remains opt-in. */
export function requestFeishuClipboardPermissions(): Promise<boolean> {
  // Invoke directly from the caller's click so the user gesture is preserved.
  return chrome.permissions.request({ permissions: ['clipboardRead', 'clipboardWrite'] })
}
