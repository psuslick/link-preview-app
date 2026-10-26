@echo off
setlocal EnableExtensions
REM ============================================================
REM Link Preview App: fresh, disposable Windows Sandbox bootstrap
REM Git-safe SOURCE COPY. Execute inside Windows Sandbox only.
REM Mapped host dependency folder must remain READ-ONLY.
REM ============================================================

set "ROOT=C:\Users\WDAGUtilityAccount\Desktop\SandboxBootstrap"
set "APP=C:\App"
set "GITEXE=%ROOT%\git\cmd\git.exe"
set "NODEDIR=%ROOT%\node"
set "NODEEXE=%NODEDIR%\node.exe"
set "NPMCMD=%NODEDIR%\npm.cmd"
set "PATH=%ROOT%\git\cmd;%ROOT%\git\usr\bin;%ROOT%\git\mingw64\bin;%NODEDIR%;%PATH%"
REM Never point HOME, npm cache, or a writable browser profile at the host mapping.
set "HOME=%TEMP%\LinkPreviewGitHome"
set "NPM_CONFIG_CACHE=%TEMP%\LinkPreviewNpmCache"
if not exist "%HOME%" mkdir "%HOME%"

if not exist "%GITEXE%" goto MISSING_GIT
if not exist "%NODEEXE%" goto MISSING_NODE
if not exist "%NPMCMD%" goto MISSING_NODE

REM Edge policy value 0 means NO enforced Bing restriction; it does not
REM itself set Bing SafeSearch Off or bypass provider-required confirmations.
reg add "HKCU\Software\Policies\Microsoft\Edge" /v ForceBingSafeSearch /t REG_DWORD /d 0 /f >nul 2>&1

REM Clone public source into Sandbox-local C:\App (never modify the mapped folder).
if exist "%APP%" rmdir /s /q "%APP%"
echo [1/4] Cloning latest Git repository into Sandbox-local storage...
"%GITEXE%" clone --depth 1 https://github.com/psuslick/link-preview-app.git "%APP%"
if errorlevel 1 goto CLONE_FAIL

REM Dependencies are installed only inside the disposable Sandbox. Reuse an
REM optional READ-ONLY host payload if present; otherwise use npm normally.
echo [2/4] Preparing backend dependencies...
if exist "%ROOT%\deps\server-node_modules" (
    xcopy "%ROOT%\deps\server-node_modules" "%APP%\server\node_modules\" /E /I /Q /Y >nul
) else (
    pushd "%APP%\server"
    call "%NPMCMD%" install --no-audit --no-fund --prefer-offline
    if errorlevel 1 goto INSTALL_FAIL_SERVER
    popd
)

echo [3/4] Preparing frontend dependencies...
if exist "%ROOT%\deps\client-node_modules" (
    xcopy "%ROOT%\deps\client-node_modules" "%APP%\client\node_modules\" /E /I /Q /Y >nul
) else (
    pushd "%APP%\client"
    call "%NPMCMD%" install --no-audit --no-fund --prefer-offline
    if errorlevel 1 goto INSTALL_FAIL_CLIENT
    popd
)

echo [4/4] Starting Link Preview services...
start "LinkPreview Server" /D "%APP%\server" cmd /k ""%NPMCMD%" run dev"
start "LinkPreview Client" /D "%APP%\client" cmd /k ""%NPMCMD%" run dev"

REM Open a DEDICATED disposable Edge profile. The unpacked tab collector
REM is loaded only for this Sandbox profile; it never reads host browser tabs.
set "EDGE_EXE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE_EXE%" set "EDGE_EXE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
set "EDGE_PROFILE=%TEMP%\LinkPreviewEdgeProfile"
set "EDGE_EXTENSION=%APP%\edge-tab-collector"
if not exist "%EDGE_EXE%" goto NO_EDGE
if exist "%EDGE_EXTENSION%\manifest.json" (
    start "LinkPreview Edge" "%EDGE_EXE%" --user-data-dir="%EDGE_PROFILE%" --no-first-run --load-extension="%EDGE_EXTENSION%" "http://127.0.0.1:5173"
) else (
    echo [!] Edge tab collector was not found in Git clone. Starting app without extension.
    start "LinkPreview Edge" "%EDGE_EXE%" --user-data-dir="%EDGE_PROFILE%" --no-first-run "http://127.0.0.1:5173"
)
goto SUCCESS

:NO_EDGE
echo [!] Could not locate Microsoft Edge. Open http://127.0.0.1:5173 manually.
:SUCCESS
echo.
echo === App launched in Windows Sandbox ===
echo NOTE: Edge may ignore --load-extension on some versions/policies.
echo If Collect Open Tabs is unavailable, open edge://extensions, enable
 echo Developer mode, and load C:\App\edge-tab-collector manually.
exit /b 0

:INSTALL_FAIL_SERVER
popd
echo [!] Backend npm installation failed. Check local dependency payload/network.
pause
exit /b 1
:INSTALL_FAIL_CLIENT
popd
echo [!] Frontend npm installation failed. Check local dependency payload/network.
pause
exit /b 1
:MISSING_GIT
echo [!] Portable Git not found at %GITEXE%
pause
exit /b 1
:MISSING_NODE
echo [!] Portable Node/npm not found beneath %NODEDIR%
pause
exit /b 1
:CLONE_FAIL
echo [!] Git clone failed. The published repository must contain the full v2.7.6 app.
pause
exit /b 1
