param(
  [Parameter(Mandatory = $true)][ValidateSet('SendSelf', 'SendFriend', 'Qr', 'Query')][string]$Mode,
  [switch]$ApproveTestSend,
  [switch]$ApproveTestQr,
  [switch]$ApproveTestQuery,
  [string]$Receipt
)
$ErrorActionPreference = 'Stop'
if (($Mode -in @('SendSelf', 'SendFriend')) -and -not $ApproveTestSend) { throw '发送测试需要 -ApproveTestSend，尚未请求任何接口。' }
if ($Mode -eq 'Qr' -and -not $ApproveTestQr) { throw '生成测试二维码需要 -ApproveTestQr，尚未请求任何接口。' }
if ($Mode -eq 'Query' -and (-not $ApproveTestQuery -or $Receipt -notmatch '^[A-Za-z0-9_-]{1,128}$')) { throw '查询需要 -ApproveTestQuery 和本次 -Receipt。' }

function Read-ProbeCredential([string]$Prompt) {
  $protectedValue = Read-Host -Prompt $Prompt -AsSecureString
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($protectedValue)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer); $protectedValue.Dispose() }
}

$credentialNames = @('CLASSREP_PROBE_PUSHPLUS_TOKEN', 'CLASSREP_PROBE_PUSHPLUS_SECRET', 'CLASSREP_PROBE_PUSHPLUS_RECIPIENT')
$previousValues = @{}
if ($Mode -in @('Qr', 'Query')) {
  Write-Host '准备：在 PushPlus 官网开放接口设置中配置 SecretKey 和本机公网安全 IP。SecretKey 不同于用户 Token。'
  Write-Host '配置说明：https://www.pushplus.plus/doc/guide/openApi.html'
  Write-Host '尚未配置可按 Ctrl+C 取消；不要把任何凭据发到聊天中。'
}
foreach ($credentialName in $credentialNames) { $previousValues[$credentialName] = [Environment]::GetEnvironmentVariable($credentialName, 'Process') }
try {
  foreach ($credentialName in $credentialNames) { [Environment]::SetEnvironmentVariable($credentialName, $null, 'Process') }
  $env:CLASSREP_PROBE_PUSHPLUS_TOKEN = Read-ProbeCredential '仅在此输入 PushPlus 用户 Token（不显示、不保存）'
  if ($Mode -in @('Qr', 'Query')) { $env:CLASSREP_PROBE_PUSHPLUS_SECRET = Read-ProbeCredential '仅在此输入开发设置的 SecretKey（不显示、不保存）' }
  if ($Mode -eq 'SendFriend') { $env:CLASSREP_PROBE_PUSHPLUS_RECIPIENT = Read-ProbeCredential '仅在此输入指定测试好友令牌（不显示、不保存）' }
  $approvalArgument = if ($Mode -eq 'Qr') { '--approve-test-qr' } elseif ($Mode -eq 'Query') { '--approve-test-query' } else { '--approve-test-send' }
  & node (Join-Path $PSScriptRoot 'reminder-probe-session.mjs') $Mode $approvalArgument $Receipt
  $probeExitCode = $LASTEXITCODE
} finally {
  foreach ($credentialName in $credentialNames) { [Environment]::SetEnvironmentVariable($credentialName, $previousValues[$credentialName], 'Process') }
}
if ($probeExitCode -ne 0) { throw '验证工具未成功结束，请按上面的固定提示检查；不要公开凭据。' }
