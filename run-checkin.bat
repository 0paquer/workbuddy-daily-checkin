@echo off
setlocal
rem WorkBuddy daily check-in launcher for Windows CMD / double-click
rem Auto-detect node: prefer WorkBuddy managed node, else node on PATH

set "SCRIPT_DIR=%~dp0"
set "CHECKIN_JS=%SCRIPT_DIR%checkin.js"
set "NODE_EXE="

rem 1) WorkBuddy managed node (any version dir)
if defined USERPROFILE (
  for /d %%d in ("%USERPROFILE%\.workbuddy\binaries\node\versions\*") do (
    if exist "%%d\node.exe" set "NODE_EXE=%%d\node.exe"
  )
)

rem 2) fallback: node on PATH
if not defined NODE_EXE (
  where node >nul 2>&1 && set "NODE_EXE=node"
)

if not defined NODE_EXE (
  echo [FAIL] node not found: please install Node.js or confirm WorkBuddy is installed
  exit /b 5
)

"%NODE_EXE%" "%CHECKIN_JS%" %*
endlocal
