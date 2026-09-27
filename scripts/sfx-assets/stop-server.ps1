# Stops the ClassRep backend: node.exe processes whose command line runs app\server\dist\index.js
$procs = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*app\server\dist\index.js*' })
foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
if ($procs.Count -gt 0) { Write-Host ("Stopped " + $procs.Count + " ClassRep server process(es).") }
else { Write-Host 'ClassRep is not running.' }
