@echo off
setlocal EnableExtensions
REM Manual troubleshooting helper, Sandbox-only. No persistent debug files.
set "ROOT=C:\Users\WDAGUtilityAccount\Desktop\SandboxBootstrap"
set "APP=C:\App"
set "NODEDIR=%ROOT%\node"
set "NPMCMD=%NODEDIR%\npm.cmd"
set "PATH=%NODEDIR%;%PATH%"
set "NPM_CONFIG_CACHE=%TEMP%\LinkPreviewNpmCache"
if not exist "%APP%\server\package.json" goto NO_APP
if not exist "%NPMCMD%" goto NO_NPM

if not exist "%APP%\server\node_modules" (
    pushd "%APP%\server"
    call "%NPMCMD%" install --no-audit --no-fund --prefer-offline
    if errorlevel 1 (popd & goto FAIL)
    popd
)
if not exist "%APP%\client\node_modules" (
    pushd "%APP%\client"
    call "%NPMCMD%" install --no-audit --no-fund --prefer-offline
    if errorlevel 1 (popd & goto FAIL)
    popd
)
call "%~dp0restart-app.cmd"
exit /b %ERRORLEVEL%
:NO_APP
echo [!] Missing C:\App. Run run-bootstrap.cmd first.
exit /b 1
:NO_NPM
echo [!] Portable npm missing.
exit /b 1
:FAIL
echo [!] Dependency installation failed.
exit /b 1
