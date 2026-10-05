# preview.1：Chrome 调试权限声明修复

用户报告插件卡片出现错误，并定位到 `optional_permissions` 的 debugger 声明。Chrome 官方明确规定 debugger 不能作为可选权限：https://developer.chrome.com/docs/extensions/reference/api/permissions 。

## 根因与修复

首版将 debugger 放入 optional_permissions，并在飞书同步按钮中与剪贴板权限一起请求。Chrome 不会以这种方式授予 debugger 能力，飞书同步因此无法执行。

修复将 debugger 移到安装时的 permissions；clipboardRead、clipboardWrite 保持可选。弹窗及本地导入页复用同一权限请求函数，仅在用户点击同步时申请两项剪贴板权限。后台创建文档之前仍检查完整权限。界面和说明同步修正；version_name 为 2.0.9-feishu-local-preview.1。

## 验证

- 对用户安装目录的旧构建运行真实 Chromium 检查：扩展 ID `phldelhkcnpidbnaegibmeodlihcomah` 与用户截图一致，debuggerGranted=false；能力断言失败（退出码 1）。
- 修复版真实检查：debuggerGranted=true，实际 chrome.debugger.attach、Runtime.evaluate 和 detach 成功（退出码 0）。
- Chromium 151 没有将旧声明计入 manifestErrors/installWarnings，但仍未授予该能力；不同 Chrome 版本可能以警告或运行错误体现。不以“扩展卡片显示启用”推断权限已生效。
- 新增两个权限回归测试；扩展 34/34 测试通过。TypeScript 与生产构建通过，diff check 通过。
- 再次执行真实本地页面、安全预览、缺图阻止、后台来源校验、剪贴板拒绝和本地 ZIP 内容验证，全部通过。

此次验证没有覆盖真实飞书账号保存或 OneNote OAuth。首版浏览器验证没有检查 debugger 的实际授予状态，遗漏了这个错误；本次以真实 API 授予与调用作为新增验收条件。

## 安装目录更新

修复覆盖同一已加载目录的构建文件，保留原 ZIP 作为历史版本。无需删除插件；在 chrome://extensions 点击该插件的重新加载按钮。若 Chrome 因必需权限变化要求确认，请按界面提示完成。刷新后 version_name 应出现 preview.1。
