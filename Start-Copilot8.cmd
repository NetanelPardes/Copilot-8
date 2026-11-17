@echo off
setlocal
cd /d "%~dp0"

set "COPILOT_URL=http://localhost:5080"

if not exist "BallardWeb.csproj" (
    echo Place this file next to BallardWeb.csproj.
    pause
    exit /b 1
)

rem Skip startup if the Copilot 8 server is already responding.
powershell -NoProfile -Command "try { Invoke-RestMethod ($env:COPILOT_URL + '/api/board') -TimeoutSec 2 -ErrorAction Stop | Out-Null; exit 0 } catch { exit 1 }"
if errorlevel 1 (
    start "Copilot 8 Server" cmd /k "dotnet run"
)

rem Wait for the API before opening Chrome.
powershell -NoProfile -Command "$url = $env:COPILOT_URL; $deadline = (Get-Date).AddSeconds(60); do { try { Invoke-RestMethod ($url + '/api/board') -TimeoutSec 2 -ErrorAction Stop | Out-Null; Start-Process chrome.exe -ArgumentList $url -ErrorAction Stop; exit 0 } catch { $lastError = $_.Exception.Message; Start-Sleep -Seconds 1 } } while ((Get-Date) -lt $deadline); Write-Host $lastError; exit 1"

if errorlevel 1 (
    echo Could not open Copilot 8. Check the server window and verify Chrome is installed.
    pause
    exit /b 1
)