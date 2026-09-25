' Launch-Simulator.vbs
' ---------------------------------------------------------------------------
' One-click launcher for the FPV Drone Simulator.
' Double-click this file: it opens a terminal running the Vite dev server
' (`npm run dev`) and then opens the simulator in your default browser.
' No more typing commands by hand.
'
' It works from wherever you put it inside the project folder — it resolves
' the project directory from its own location. If node_modules is missing
' (fresh checkout), it runs `npm install` first, automatically.
' ---------------------------------------------------------------------------
Option Explicit

Dim shell, fso, projectDir, nodeModulesPath, bootCommand

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' The project root is the folder this script lives in.
projectDir = fso.GetParentFolderName(WScript.ScriptFullName)
nodeModulesPath = fso.BuildPath(projectDir, "node_modules")

If Not fso.FolderExists(nodeModulesPath) Then
  ' First run ever: install dependencies, then start the dev server.
  ' /k keeps the window open so you can see the output.
  bootCommand = "cmd /k npm install && npm run dev"
Else
  bootCommand = "cmd /k npm run dev"
End If

shell.CurrentDirectory = projectDir
shell.Run bootCommand, 1, False

' Give Vite a few seconds to boot before opening the browser.
WScript.Sleep 6000
shell.Run "http://localhost:5173", 1, False

Set shell = Nothing
Set fso = Nothing
