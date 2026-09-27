# ClassRep SFX installer (runs hidden from launch-install.vbs inside the SFX temp dir).
# Flow: stop old server -> robocopy payload -> %LOCALAPPDATA%\ClassRep
#       -> create desktop shortcut -> start server hidden (server opens the browser).
$ErrorActionPreference = 'Stop'
$src  = Join-Path $PSScriptRoot 'ClassRep'
$dest = Join-Path $env:LOCALAPPDATA 'ClassRep'

function Stop-ClassRepServer {
    for ($i = 0; $i -lt 8; $i++) {
        $procs = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -like '*app\server\dist\index.js*' })
        if ($procs.Count -eq 0) { return $true }
        foreach ($pr in $procs) { Stop-Process -Id $pr.ProcessId -Force -ErrorAction SilentlyContinue }
        Start-Sleep -Milliseconds 500
    }
    $left = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like '*app\server\dist\index.js*' })
    return ($left.Count -eq 0)
}

function Fail($msg) {
    $sh = New-Object -ComObject WScript.Shell
    $sh.Popup("ClassRep install failed:`n$msg", 0, 'ClassRep', 16) | Out-Null
    exit 1
}

try {
    if (-not (Test-Path $src)) { throw "payload missing: $src" }

    # 1) stop old server so node.exe / dlls are not locked during update
    [void](Stop-ClassRepServer)

    # 2) sync payload -> install dir. Copies/overwrites only, never deletes user data (data\classrep.db).
    & "$env:SystemRoot\System32\Robocopy.exe" $src $dest /E /R:2 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy failed with code $LASTEXITCODE" }

    # 3) desktop shortcut -> hidden launcher
    $desktop = [Environment]::GetFolderPath('Desktop')
    $ws = New-Object -ComObject WScript.Shell
    $lnk = $ws.CreateShortcut((Join-Path $desktop 'ClassRep.lnk'))
    $lnk.TargetPath = Join-Path $env:SystemRoot 'System32\wscript.exe'
    $lnk.Arguments = '"' + (Join-Path $dest 'start-hidden.vbs') + '"'
    $lnk.WorkingDirectory = $dest
    $lnk.IconLocation = "$env:SystemRoot\System32\shell32.dll,137"
    $lnk.Save()

    # 4) start server hidden; the server itself opens the browser
    Start-Process -FilePath (Join-Path $dest 'runtime\node.exe') `
        -ArgumentList ('"' + (Join-Path $dest 'app\server\dist\index.js') + '"') `
        -WorkingDirectory $dest -WindowStyle Hidden | Out-Null
}
catch {
    Fail $_.Exception.Message
}
