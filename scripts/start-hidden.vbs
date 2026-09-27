' ClassRep background start (no console window). Optional dev tool — the desktop
' shortcut now points at 启动.bat (production build). This runs the dev server:
'   node scripts\dev.mjs --background   (logic and comments live in dev.mjs)
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
sh.CurrentDirectory = root
sh.Run "node """ & root & "\scripts\dev.mjs"" --background", 0, False
