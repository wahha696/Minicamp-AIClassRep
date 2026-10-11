# AI 课代表（ClassRep）

把 QQ 与微信群里的作业、考试、活动和截止日期整理为日程，保留原始消息来源，支持改期、取消、待确认、课表和待办。

程序、数据库和凭证保存在本机。AI 整理、偏好总结和对话会将相关消息及必要上下文发送给你配置的 AI 服务；本机运行不等于消息永不外发。

## Windows 从源码开始

支持 Windows 10/11 x64。联网克隆后：

~~~powershell
git clone https://github.com/wahha696/Minicamp-AIClassRep.git
Set-Location Minicamp-AIClassRep
.\启动.bat
~~~

启动器准备 Node、pnpm 依赖、便携 Python 和前端，再打开本地网页。已有 Node.js 24 LTS（最低 22.16）及 pnpm 10.34.5 也可执行：

~~~powershell
pnpm install --frozen-lockfile
node scripts/fastjudge-setup.mjs
pnpm build
pnpm start
~~~

首次准备依赖需要访问公开下载源。已有设置和数据库不会随仓库分发。完整步骤、检查命令及备份恢复限制见 [源码安装与验证](docs/源码安装与验证.md)。

## 连接自己的服务

- 在设置页填写自己的 AI 服务地址、API Key 和模型；支持 OpenAI 兼容协议，默认 DeepSeek。也可复制 `.env.example` 为 `.env`。无凭证可以打开应用，不能完成云端整理。
- QQ 需要已安装的 QQ NT 电脑版和本人扫码或登录验证。NapCat 程序资源已随仓库跟踪；缺组件时可按连接页提示下载固定版本。账号配置、缓存和登录数据不提交。
- 微信需本机已经登录。目前仅 Windows 微信 **4.1.15.50 指定模块构建**有真实验证证据，不承诺所有同版本构建或新版本。群管理中填入以 `xwechat_files` 结尾的存储位置，读取群目录后开启所需群。路径按账号记忆，但读取许可不持久化。
- 历史补全仅覆盖客户端实际保留的记录。图片、语音等未支持内容会明确报告；不自动 OCR 或转写。群失败不影响其他群继续补全。

## 功能与数据边界

- 一个本机业务空间，QQ 与微信独立连接；跨平台完全一致且唯一对应的通知可合并并保留来源。
- 规则过滤、本地快判、AI 提取和事件合并。低分过滤存在漏判风险；整理失败保留积压并限制重试。
- 今日、本周、课表导入、手工待办、等级、回收站和 ICS 导出。人工修正字段受保护，冲突进入待确认。
- 设置页可导出当前空间业务备份与脱敏诊断；自动保留每日快照。恢复不携带登录、Key 或微信读取权限，微信群需重新开启并按需补历史。
- 手机只读访问默认关闭，需在电脑设置页主动开启并使用带凭据链接；管理操作仅限本机。
- 手机自动提醒仍关闭，仅支持保存规则，渠道未完成验收。
- 关闭网页不会退出程序；关闭启动窗口或 Ctrl+C 正常退出。后端更新后须退出旧实例再启动；`pnpm start` 不会拉 Git，`pnpm dev:start` 会更新代码。

现行方案见 [当前需求与架构](docs/当前需求与架构.md)，本地操作见 [QQ/微信验证步骤](docs/本地试用验收-QQ微信双源.md)。根目录早期架构文档仅作历史参考。

## 开发与检查

~~~powershell
$env:WECHAT4_TEST_PYTHON = (Resolve-Path .\classrep-fastjudge\py\python.exe).Path
pnpm test
node scripts/test-wechat-python.mjs
node --test scripts/lib/*.test.mjs scripts/update.test.mjs scripts/rescue-upgrade.test.mjs
pnpm typecheck
pnpm build
~~~

测试使用模拟消息和临时数据库。无配置干净检出可运行 `node scripts/smoke-clean.mjs` 验证安全启动。Docker/Linux 模板仅供开发参考，本次未提供容器运行保证，微信不支持该环境。

## 安装包与升级

[Releases](https://github.com/wahha696/Minicamp-AIClassRep/releases) 中既有安装包可能早于本次源码功能。本次只更新源码，不发布新安装包。

旧版升级解压失败时，按 Release 说明使用配套的 `修复升级.bat` 和 `修复升级.ps1`。更新机制验证发布签名与 SHA-256，保留程序及数据恢复入口。详见 [Windows 验收](Windows真机验收.md) 和 [安全说明](SECURITY.md)。

请勿提交 .env、数据库、聊天、日志、登录配置或本地研究材料。微信读取组件的来源与许可见 [NOTICE](tools/wechat4-read-probe/NOTICE.md)。
