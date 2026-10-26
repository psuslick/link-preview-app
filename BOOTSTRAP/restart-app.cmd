@echo off
setlocal EnableExtensions
REM Execute inside Windows Sandbox only; uses C:\App cloned by run-bootstrap.cmd.
set "ROOT=C:\Users\WDAGUtilityAccount\Desktop\SandboxBootstrap"
set "APP=C:\App"
set "NODEDIR=%ROOT%\node"
set "NPMCMD=%NODEDIR%\npm.cmd"
set "PATH=%NODEDIR%;%PATH%"
if not exist "%APP%\server\package.json" goto NO_APP
if not exist "%NPMCMD%" goto NO_NPM

echo Restarting app server and client. Other Sandbox-local Node tasks will stop.
taskkill /IM node.exe /F >nul 2>&1
start "LinkPreview Server" /D "%APP%\server" cmd /k ""%NPMCMD%" run dev"
start "LinkPreview Client" /D "%APP%\client" cmd /k ""%NPMCMD%" run dev"
echo Restarted. Browser session remains inside Sandbox.
exit /b 0
:NO_APP
echo [!] C:\App not present. Run run-bootstrap.cmd first.
exit /b 1
:NO_NPM
echo [!] Portable npm missing from SandboxBootstrap.
exit /b 1
