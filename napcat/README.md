# NapCat（采集端运行时）

本目录是 [NapCatQQ](https://github.com/NapNeko/NapCatQQ) **v4.18.28** 的 Windows x64 发行文件，
随本仓库提交，克隆即可用，不需要另外下载。

- 上游：<https://github.com/NapNeko/NapCatQQ>
- 版本：v4.18.28
- 许可证：Limited Redistribution License（见同目录 `LICENSE`）。
  该许可证允许在「附带完整许可证文本、标明来源与版权」的前提下再分发；
  本项目仅再分发**未修改**的 NapCat 文件，且为非商业用途。

## 目录内容

| 文件 / 目录 | 说明 |
|---|---|
| `NapCatWinBootMain.exe` / `NapCatWinBootHook.dll` | NapCat 的 QQ 注入启动器 |
| `napcat.mjs`、`conout-*.js`、`worker/`、`node_modules/`、`static/`、`package.json`、`qqnt.json` | NapCat 本体与依赖（原版，未修改） |
| `native/` | 仅保留 `win32-x64` 原生库（Linux / macOS / arm64 版本已删除，约省 70MB） |

## 不随仓库提交的内容（见根目录 `.gitignore`）

以下文件由运行时生成或包含账号数据，不会被提交：

- `config/`（`napcat_<uin>.json`、`onebot11_<uin>.json` 等，由 `apps/server` 启动时写入）
- `loadNapCat.js`（由 `apps/server/src/napcat/config.ts` 在启动时生成，用于注入快速登录参数；
  它只存在于用户机器上，不属于「公开发布的修改」）
- `cache/`、`logs/`、`guild*.db*`、`_loader_debug.log`、`*.bat`、`plugins/`

## 升级

只在需要时升级（一次升级约让仓库历史增加 20MB）：

1. 从上游 Release 下载同版本号的 NapCat.Win.x64 压缩包；
2. 按上表裁剪非 Windows x64 的 `native/` 文件；
3. 更新本文档与 `scripts/versions.json` 里的版本号；
4. 真机回归：扫码登录、收消息、快速登录（`config.ts` 的 `-q` 注入）。
