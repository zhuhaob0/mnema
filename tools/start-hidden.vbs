' Launch the mnema supervisor with no console window.
' Placed in the user's Startup folder; started at logon.
Option Explicit
Dim sh, nodeExe, script, cmd
Set sh = CreateObject("WScript.Shell")

nodeExe = "D:\dev_tools\Nodejs\node.exe"
script = "E:\Code\mnema\tools\supervise.mjs"

cmd = """" & nodeExe & """ """ & script & """"
' 0 = hidden window, False = do not wait
sh.Run cmd, 0, False
