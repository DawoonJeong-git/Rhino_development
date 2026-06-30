@echo off
setlocal

set "PRODROOT=C:\SpaceWork_deploy"
set "DEVROOT=C:\SpaceWork_develop"
set "TUNNEL_NAME=%~1"
if "%TUNNEL_NAME%"=="" set "TUNNEL_NAME=space-work-home"

echo [0/3] Stopping existing web runtimes if any
set "PORT=3000"
set "ROUTE_BASE_PATH=/main"
cd /d "%PRODROOT%"
powershell -ExecutionPolicy Bypass -File "deploy\start-server.ps1" -Managed -StopOnly
if errorlevel 1 goto :error
powershell -ExecutionPolicy Bypass -File "deploy\start-cloudflare-tunnel.ps1" -Managed -StopOnly -TunnelName "%TUNNEL_NAME%"
if errorlevel 1 goto :error

set "PORT=3001"
set "ROUTE_BASE_PATH=/test"
cd /d "%DEVROOT%"
powershell -ExecutionPolicy Bypass -File "deploy\start-server.ps1" -Managed -StopOnly
if errorlevel 1 goto :error

echo.
echo [1/3] Starting main web on https://spaceswork.net/main
set "PORT=3000"
set "ROUTE_BASE_PATH=/main"
cd /d "%PRODROOT%"
powershell -ExecutionPolicy Bypass -File "deploy\start-server.ps1" -Managed
if errorlevel 1 goto :error
powershell -ExecutionPolicy Bypass -File "deploy\start-cloudflare-tunnel.ps1" -Managed -TunnelName "%TUNNEL_NAME%"
if errorlevel 1 goto :error

echo.
echo [2/3] Starting test web on https://spaceswork.net/test
set "PORT=3001"
set "ROUTE_BASE_PATH=/test"
cd /d "%DEVROOT%"
powershell -ExecutionPolicy Bypass -File "deploy\start-server.ps1" -Managed
if errorlevel 1 goto :error

echo.
echo [3/3] Startup completed.
echo Both web runtimes were started.
echo Main: https://spaceswork.net/main
echo Test: https://spaceswork.net/test
goto :end

:error
echo.
echo Failed to start one or both web runtimes.
pause
exit /b 1

:end
endlocal
