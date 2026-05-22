@echo off
chcp 65001 >nul
title Packet Lab Manager

net session >nul 2>&1
if %errorlevel% neq 0 (
    echo [INFO] Requesting administrator privileges for Npcap...
    powershell -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

set "ROOT=%~dp0"
set "SERVER_DIR=%ROOT%server"

:: Npcap must be in PATH before node loads cap.node
set "PATH=C:\Windows\System32\Npcap;%PATH%"

for /f "tokens=*" %%A in ('powershell -NoProfile -Command "$a=Get-NetIPAddress -AddressFamily IPv4|Where-Object{$_.IPAddress -notmatch '^(127\.|169\.254\.)'}|Sort-Object{if($_.IPAddress -match '^(172\.|10\.|192\.168\.)'){0}else{1}}|Select-Object -First 1 -ExpandProperty IPAddress;if($a){$a}else{'localhost'}"') do set "MY_IP=%%A"
if not defined MY_IP set "MY_IP=localhost"

echo.
echo  =====================================================
echo   Packet Lab Manager  -  Port 8080
echo   Local : http://localhost:8080
echo   Remote: http://%MY_IP%:8080
echo  =====================================================
echo.

echo [1/2] Killing old node processes...
taskkill /IM node.exe /F >nul 2>&1
timeout /t 2 >nul

echo [2/2] Starting Node.js server (port 8080)...
if not exist "%SERVER_DIR%\node_modules" (
    echo [INFO] Installing dependencies...
    pushd "%SERVER_DIR%"
    call npm.cmd install --prefer-offline
    popd
)
start "PacketLabManager" /MIN cmd /c "set PATH=C:\Windows\System32\Npcap;%PATH% && pushd %SERVER_DIR% && node server.js"
timeout /t 3 >nul

start http://localhost:8080

echo.
echo  =====================================================
echo   Ready!
echo   Local : http://localhost:8080
echo   Remote: http://%MY_IP%:8080
echo  =====================================================
echo.
pause
