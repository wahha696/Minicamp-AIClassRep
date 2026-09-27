' ClassRep background launcher (no console window). Target of the desktop shortcut.
' Runs: <install>\runtime\node.exe app\server\dist\index.js  (hidden)
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
root = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = root
sh.Run """" & root & "\runtime\node.exe"" ""app\server\dist\index.js""", 0, False
