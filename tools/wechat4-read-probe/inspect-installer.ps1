<#
Read-only installer inspection. Does not download, launch, install, unpack, or
change execution policy. Hold a read handle denying writes/deletes throughout.
Authenticode and PE version resources describe this artifact, not the version
of the client that will eventually be loaded after installation.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][ValidatePattern('^[0-9A-Fa-f]{64}$')][string]$ExpectedSha256
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$installerItem = Get-Item -LiteralPath $Path -Force
if ($installerItem.PSIsContainer -or $installerItem.Extension -ine '.exe' -or
    $installerItem.Length -lt 1024 -or $installerItem.Length -gt 512MB -or
    ($installerItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'INSTALLER_FILE_TYPE_OR_SIZE'
}
$installerStream = $null
$digestProvider = $null
try {
    $installerStream = [IO.File]::Open($installerItem.FullName, [IO.FileMode]::Open,
        [IO.FileAccess]::Read, [IO.FileShare]::Read)
    $digestProvider = [Security.Cryptography.SHA256]::Create()
    $actualSha256 = ([BitConverter]::ToString($digestProvider.ComputeHash($installerStream))).Replace('-', '')
    if ($actualSha256 -ine $ExpectedSha256) {
        throw 'INSTALLER_HASH_MISMATCH'
    }
    $installerStream.Position = 0
    $binaryReader = [IO.BinaryReader]::new($installerStream, [Text.Encoding]::ASCII, $true)
    try {
        if ($binaryReader.ReadUInt16() -ne 0x5A4D) { throw 'INSTALLER_NOT_PE' }
        $installerStream.Position = 0x3C
        $peOffset = $binaryReader.ReadUInt32()
        if ($peOffset -gt $installerStream.Length - 24) { throw 'INSTALLER_PE_BOUNDS' }
        $installerStream.Position = $peOffset
        if ($binaryReader.ReadUInt32() -ne 0x4550) { throw 'INSTALLER_NOT_PE' }
        $machine = $binaryReader.ReadUInt16()
    } finally {
        $binaryReader.Dispose()
    }
    $signature = Get-AuthenticodeSignature -LiteralPath $installerItem.FullName
    $version = [Diagnostics.FileVersionInfo]::GetVersionInfo($installerItem.FullName)
    [ordered]@{
        SizeBytes = $installerStream.Length
        Sha256 = $actualSha256
        SignatureStatus = [string]$signature.Status
        SignerSubject = $(if ($null -ne $signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { $null })
        SignerThumbprint = $(if ($null -ne $signature.SignerCertificate) { $signature.SignerCertificate.Thumbprint } else { $null })
        TimestampSubject = $(if ($null -ne $signature.TimeStamperCertificate) { $signature.TimeStamperCertificate.Subject } else { $null })
        FileVersion = $version.FileVersion
        ProductVersion = $version.ProductVersion
        CompanyName = $version.CompanyName
        ProductName = $version.ProductName
        PeMachine = ('0x{0:X4}' -f $machine)
        Executed = $false
    } | ConvertTo-Json -Depth 3
    if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
        throw 'INSTALLER_SIGNATURE_NOT_VALID'
    }
} finally {
    if ($null -ne $digestProvider) { $digestProvider.Dispose() }
    if ($null -ne $installerStream) { $installerStream.Dispose() }
}
