@echo off
set "PRODROOT=C:\SpaceWork_deploy"
set "TUNNEL_NAME=%~1"
if "%TUNNEL_NAME%"=="" set "TUNNEL_NAME=space-work-home"
cd /d "%PRODROOT%"
powershell -ExecutionPolicy Bypass -File "deploy\start-server.ps1" -Managed
if errorlevel 1 exit /b %errorlevel%
powershell -ExecutionPolicy Bypass -File "deploy\start-cloudflare-tunnel.ps1" -Managed -TunnelName "%TUNNEL_NAME%"
if errorlevel 1 exit /b %errorlevel%
