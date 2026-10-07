# ClassRep Windows 真机验收

自动化 CI 只能证明构建、数据库、网页与模拟更新链路可运行，不能替代真实 QQ、扫码、普通用户权限和桌面切换测试。
每个候选发布包至少在一台 Windows 10 和一台 Windows 11 机器执行本清单；不得用开发机已有的依赖冒充首次安装。

## 测试环境

1. 新建普通 Windows 用户，不以管理员身份运行任何 ClassRep 文件。
2. 将候选 `ClassRep.zip` 解压到同时包含中文和空格的目录，例如 `D:\学生 工具\ClassRep`。
3. 安装当前受支持的 QQ NT；不预装 Node、pnpm、Git 或 Python。
4. 使用专门的测试 QQ 号和测试群，禁止把真实聊天内容写进验收报告或 Issue。

## 执行

先双击 `启动.bat` 完成首次启动和 AI 设置，再在 PowerShell 中运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows-acceptance.ps1 -InstallDirectory 'D:\学生 工具\ClassRep'
```

按提示验证：首次启动、扫码登录、新增通知、改期、取消/待确认、A→B→A 换号、返回 QQ 与历史补读、自动升级。
脚本只记录通过/失败、Windows 版本和安装路径形态，不记录 QQ 号、群号、姓名、密钥或消息正文。

报告保存在 `data/acceptance/windows-*.json`。任何一项失败都不得发布；修复后必须重新从干净目录完整执行，而不是只重测最后一步。

## v1.0.0 救援专项

1. 准备一个带账号数据的 v1.0.0 测试安装，复制一份后再操作。
2. 把最新 Release 的 `修复升级.bat` 与 `修复升级.ps1` 放入旧目录。
3. 关闭 ClassRep 后运行救援，确认安装目录旁出现 `ClassRep-data-backup-*`。
4. 启动新版本，核对账号、群、日程、课表、待办和设置仍在。
5. 人为改坏 `ClassRep.manifest.json` 后做离线救援，必须在替换程序和创建备份之前停止。

