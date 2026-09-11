@echo off
setlocal
REM Repo-local launcher. Prefer: npm install -g @node30/neo && neo install
set "NEO_ROOT=%~dp0.."
if exist "%LOCALAPPDATA%\Neo\neo_root.txt" (
  set /p NEO_ROOT=<"%LOCALAPPDATA%\Neo\neo_root.txt"
)
where node >nul 2>nul
if errorlevel 1 (
  echo NEO: node not found on PATH
  exit /b 1
)
set "NEO_WORKSPACE=%CD%"
node "%NEO_ROOT%\bin\neo.mjs" %*
exit /b %ERRORLEVEL%
