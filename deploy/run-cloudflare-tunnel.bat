@echo off
set "TUNNEL_NAME=%~1"
if "%TUNNEL_NAME%"=="" set "TUNNEL_NAME=space-work-home"
powershell -ExecutionPolicy Bypass -File "deploy\start-cloudflare-tunnel.ps1" -Managed -TunnelName "%TUNNEL_NAME%"
if errorlevel 1 exit /b %errorlevel%
