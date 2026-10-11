/** Error categories come from the server; never infer version incompatibility from a generic failure. */
const messages: Readonly<Record<string, string>> = {
  WECHAT_NOT_RUNNING: '未找到可用的电脑微信，请先打开并登录微信后再连接。',
  WECHAT_VERSION_UNSUPPORTED: '此微信版本尚未适配。目前读取适配范围是 Windows x64 微信 4.1.15.50 的指定构建；3.x 和其他 4.x 版本需要独立适配。请保留原数据，等待兼容更新。',
  WECHAT_MODULE_UNSUPPORTED: '微信版本号可能相同，但实际程序模块的构建或结构尚未通过验证。版本号相同不保证可读取；请保留原数据，等待对应构建的适配。',
  WECHAT_PROCESS_UNAVAILABLE: '无法读取微信主进程或程序模块，尚不能判断版本是否兼容。请确认电脑微信正常运行，并检查课代表与微信的运行权限后重试。',
  WECHAT_RUNTIME_MISSING: '微信读取组件不完整：随应用提供的 Python 或读取程序缺失。请重新运行项目的启动脚本修复组件；这不是微信版本不兼容的判断。',
  WECHAT_RUNTIME_FAILED: '微信读取组件启动失败，可能是 Python 或本机原生依赖加载失败。请重新运行项目的启动脚本修复依赖，再查看启动错误；无需据此升降级微信。',
  WECHAT_MULTIPLE_CLIENTS: '检测到多个微信实例，请保留要连接的一个后重试。',
  WECHAT_IDENTITY_LOST: '微信登录状态无法确认或已经变化。请确认已登录目标账号后重新连接，原有数据保留。',
  WECHAT_IDENTITY_CHANNEL_CLOSED: '微信身份读取组件已停止。请查看应用启动错误后重新连接；目前无法判断是登录、权限还是组件问题。',
  WECHAT_CONNECTION_STALE: '连接状态已变化，请刷新状态后重试。',
  WECHAT_CONNECTION_BUSY: '微信连接正在处理，请等待当前操作结束。',
  WECHAT_WORKSPACE_NOT_READY: '当前空间尚未就绪，请先完成空间选择。',
  WECHAT_CATALOG_NOT_CURRENT: '微信登录或当前空间已变化，请重新连接后读取群列表。',
  WECHAT_CATALOG_METADATA_INVALID: '微信存储位置尚未核实，请从微信设置复制当前账号的存储位置。',
  WECHAT_CATALOG_CONTACT_SCOPE_ACCOUNT_NOT_FOUND: '所选目录下未找到当前微信账号，请核对微信设置中的存储位置。',
  WECHAT_CATALOG_CONTACT_SCOPE_ACCOUNT_AMBIGUOUS: '同一账号存在多个数据目录，请核对正确的存储位置后再读取。',
  WECHAT_CATALOG_SNAPSHOT_LOCK_BUSY: '微信正在整理本地数据，请稍后再读取群列表。',
  WECHAT_CATALOG_TIMEOUT: '读取群列表超时，读取组件已停止。请检查微信运行状态和本地读取组件后重试；这不表示存储路径错误或版本不兼容。',
  WECHAT_CATALOG_WORKER_FAILED: '群列表读取组件未能完成。请检查应用启动错误和本地依赖后重试；目前不能判断是路径、权限还是组件问题。',
  WECHAT_CATALOG_CATALOG_STATIC_ANALYSIS_FAILED: '群列表读取所需的程序模块分析失败，请检查对应构建的兼容状态和本机依赖；这不代表存储路径错误。',
};

export function wechatErrorText(code: string | null | undefined, area: 'connection' | 'catalog' = 'connection'): string {
  return code && messages[code] || (area === 'catalog'
    ? '群列表读取失败，原因尚未确定。请检查连接与应用启动错误后重试；不能仅据此判断存储位置错误。'
    : '微信连接失败，原因尚未确定。请检查应用启动错误后重试；不能仅据此判断微信版本不兼容。');
}
