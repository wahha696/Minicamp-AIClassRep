# Use explicit ZIP format and UTF-8 filenames, independent of tar and system locale.
param(
    [Parameter(Mandatory = $true)][string]$SourceDirectory,
    [Parameter(Mandatory = $true)][string]$ArchivePath
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$source = (Resolve-Path -LiteralPath $SourceDirectory).Path
$archive = [IO.Path]::GetFullPath($ArchivePath)
# Windows PowerShell's older .NET can emit backslashes in CreateFromDirectory.
# Build entries explicitly so both filenames and separators are portable.
$baseName = Split-Path -Leaf $source
$stream = [IO.File]::Open($archive, [IO.FileMode]::CreateNew)
$zip = [IO.Compression.ZipArchive]::new(
    $stream, [IO.Compression.ZipArchiveMode]::Create, $false, [Text.Encoding]::UTF8
)
try {
    foreach ($item in Get-ChildItem -LiteralPath $source -Recurse -Force) {
        $relative = $item.FullName.Substring($source.Length).TrimStart('\').Replace('\', '/')
        $entry = $baseName + '/' + $relative
        if ($item.PSIsContainer) {
            [void]$zip.CreateEntry($entry + '/')
        } else {
            [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
                $zip, $item.FullName, $entry, [IO.Compression.CompressionLevel]::Optimal
            )
        }
    }
} finally {
    $zip.Dispose()
    $stream.Dispose()
}
# Reject an archive whose launcher was lost or renamed before producing its manifest.
$zip = [IO.Compression.ZipFile]::OpenRead($archive)
try {
    $launcher = ([string][char]0x542f) + ([string][char]0x52a8) + '.bat'
    $entry = (Split-Path -Leaf $source) + '/' + $launcher
    if (-not $zip.GetEntry($entry)) { throw "ZIP launcher missing: $entry" }
} finally {
    $zip.Dispose()
}
