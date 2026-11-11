@echo off
rem Launch AIDE 2.0. Usage: AIDE.cmd [folder]
if not exist "%~dp0runtime\AIDE.exe" (
  echo runtime\AIDE.exe not found. Run: npm install ^&^& npm run setup ^&^& npm run package
  exit /b 1
)
start "" "%~dp0runtime\AIDE.exe" %*
