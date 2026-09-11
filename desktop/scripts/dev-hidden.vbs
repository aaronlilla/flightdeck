' Launches the dev Electron shell with no console window, for a taskbar or
' Start Menu shortcut. Runs `node scripts/dev.cjs` hidden and sends its output
' to .dev-userdata\dev.log. A second click while the dev shell is already
' running does not start a second watcher: it launches Electron once more with
' the same userData dir, which hits the single-instance lock and brings the
' open window to the front.
'
' scripts/make-dev-shortcut.js writes the shortcut that points here.

Option Explicit

Dim fso, sh, wmi, procs, p, root, repo, userData, running, checkoutFile, ts, checkoutDir

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
repo = fso.GetParentFolderName(root)
userData = root & "\.dev-userdata"
If Not fso.FolderExists(userData) Then fso.CreateFolder userData

' Item 4, plan step 9, 2026-09-10: the canonical checkout file wins over this
' repo, same rule as checkout-file.ts / dev.cjs's own read of it.
checkoutDir = repo
checkoutFile = sh.ExpandEnvironmentStrings("%USERPROFILE%") & "\.forge\console.checkout"
If fso.FileExists(checkoutFile) Then
  Set ts = fso.OpenTextFile(checkoutFile, 1)
  Dim fileContent
  fileContent = Trim(ts.ReadAll())
  ts.Close
  If Len(fileContent) > 0 Then checkoutDir = fileContent
End If

running = False
Set wmi = GetObject("winmgmts:\\.\root\cimv2")
Set procs = wmi.ExecQuery("SELECT CommandLine FROM Win32_Process WHERE Name = 'node.exe'")
For Each p In procs
  If Not IsNull(p.CommandLine) Then
    If InStr(p.CommandLine, "scripts\dev.cjs") > 0 Or InStr(p.CommandLine, "scripts/dev.cjs") > 0 Then running = True
  End If
Next

sh.CurrentDirectory = root

If running Then
  sh.Environment("Process")("FORGE_USER_DATA_DIR") = userData
  sh.Environment("Process")("FORGE_REPO_DIR") = checkoutDir
  sh.Run """" & root & "\node_modules\electron\dist\electron.exe"" """ & root & """", 0, False
Else
  sh.Run "cmd /c node scripts\dev.cjs > """ & userData & "\dev.log"" 2>&1", 0, False
End If
