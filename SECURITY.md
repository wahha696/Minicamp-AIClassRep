# ClassRep 安全策略

## 用户端边界

- 默认只监听 `127.0.0.1`；局域网模式必须显式开启，仅读，并使用与当前账号数据代次绑定的随机凭据。
- Host、Origin、Content-Type 和账号 epoch 分层校验；扫码、AI 配置、账号、备份、诊断和教务网登录接口不向局域网开放。
- QQ 账号数据库彼此分离；异步任务写入前同时核对账号、账号 epoch 与数据库 generation。
- 账号备份使用 SQLite 一致性快照，恢复前校验容器 SHA-256、`quick_check`、必要表和 schema 版本，并先保留恢复前数据库。

## 更新与供应链

- 新版客户端只接受由内置 Ed25519 公钥验证通过的 `ClassRep.manifest.json`，再按已签名清单校验 ZIP 大小和 SHA-256。私钥仅保存为 GitHub Actions secret。
- Release 同时生成 GitHub/Sigstore 构建来源证明。可使用 `gh attestation verify ClassRep.zip --repo wahha696/Minicamp-AIClassRep` 独立核对构建来源。
- PR 和主分支运行 CodeQL、新增依赖审查与生产依赖高危漏洞扫描；Release 流水线也会再次执行生产依赖高危审计，失败即停止打包。仓库应把 CI 与 security 设为主分支必需检查。

> `v1.0.0` 旧安装本身没有内置发布公钥，因此“修复升级”入口只能先用 GitHub Release 上的 SHA-256 清单完成信任引导。救援到新版后，后续自动更新强制验签。

## 隐私与日志

- 可下载诊断包不包含消息正文、消息/群/QQ 标识、姓名、文件路径或 API Key，只用临时别名说明每条消息的处理原因。
- 崩溃与 AI 调用错误写入日志前，统一脱敏 Bearer、API Key、token、password、secret 和操作系统用户目录。
- 教务网密码只在一次导入会话内存中短暂存在，用完即清除，不写数据库和日志。

## 报告问题

请不要在公开 Issue 中附上真实消息、QQ 号、API Key 或备份文件。先附设置页生成的脱敏诊断 JSON，并通过 GitHub 的 Security Advisory 私密报告可复现的安全问题。
