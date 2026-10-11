# Windows 微信读取运行组件

此目录提供应用使用的受控 Python worker、身份与目录校验、所选群消息读取、分页和回执投递，以及人工数据测试。

当前仅支持已验证的 Windows x64 微信 4.1.15.50 指定模块构建。普通用户应通过应用连接页和群管理进行明确授权，不要直接执行研究探针来绕过界面范围校验。任何不匹配的身份、模块或数据范围均应停止读取。

在仓库根运行 `node scripts/fastjudge-setup.mjs` 获取独立便携 Python。文字解码使用固定版本 `zstandard==0.25.0`，不依赖本机绝对 DLL 路径。测试命令为 `node scripts/test-wechat-python.mjs`，只使用临时数据库与人工消息。

产品分发文件由 `scripts/lib/wechat-runtime.mjs` 白名单管理。不要将实际输入数据库、密钥、内存转储、聊天、回执或采集日志加入此目录或提交仓库。来源说明见 [NOTICE.md](NOTICE.md)，Apache-2.0 许可全文见 [LICENSE-APACHE-2.0](LICENSE-APACHE-2.0)。
