' SFX hook: runs install.ps1 hidden (no console flash), waits for it to finish.
' The 7zSD SFX extracts this payload to a temp dir, runs this file, then deletes the temp dir.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
here = fso.GetParentFolderName(WScript.ScriptFullName)
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & here & "\install.ps1""", 0, True
