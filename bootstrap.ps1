Write-Host "=== Installing Git ==="
Invoke-WebRequest https://github.com/git-for-windows/git/releases/download/v2.45.1.windows.1/Git-2.45.1-64-bit.exe -OutFile git.exe
Start-Process git.exe -ArgumentList '/VERYSILENT' -Wait

Write-Host "=== Installing Node.js ==="
Invoke-WebRequest https://nodejs.org/dist/v20.11.1/node-v20.11.1-x64.msi -OutFile node.msi
Start-Process msiexec.exe -ArgumentList '/i node.msi /quiet /norestart' -Wait

Write-Host "=== Installing VS Code ==="
Invoke-WebRequest https://update.code.visualstudio.com/latest/win32-x64-user/stable -OutFile vscode.exe
Start-Process vscode.exe -ArgumentList '/VERYSILENT /MERGETASKS=!runcode' -Wait

Write-Host "=== Configuring Git identity ==="
git config --global user.name "psuslick"
git config --global user.email "31072678+psuslick@users.noreply.github.com"

Write-Host "=== Cloning repo ==="
cd C:\
git clone https://github.com/psuslick/link-preview-app.git
cd link-preview-app

Write-Host "=== Installing backend dependencies ==="
cd server
npm install
npx playwright install chromium

Write-Host "=== Starting backend ==="
Start-Process powershell -ArgumentList 'cd C:\link-preview-app\server; node index.js'

Write-Host "=== Installing frontend dependencies ==="
cd C:\link-preview-app\client
npm install

Write-Host "=== Starting frontend ==="
Start-Process powershell -ArgumentList 'cd C:\link-preview-app\client; npm run dev'

Write-Host "=== Opening frontend in Edge ==="
Start-Process "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" -ArgumentList "http://localhost:5173"

Write-Host "=== Opening VS Code ==="
Start-Process "C:\Users\WDAGUtilityAccount\AppData\Local\Programs\Microsoft VS Code\Code.exe" -ArgumentList "C:\link-preview-app"