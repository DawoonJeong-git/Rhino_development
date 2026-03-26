@echo off
set "PRODROOT=C:\SpaceWork_deploy"
if not exist "%PRODROOT%" set "PRODROOT=C:\Rhino_deploy"
set "TUNNEL_NAME=%~1"
if "%TUNNEL_NAME%"=="" set "TUNNEL_NAME=space-work-home"
start "Space Work Home Server" cmd /k "cd /d %PRODROOT% && powershell -ExecutionPolicy Bypass -File deploy\start-server.ps1"
start "Cloudflare Tunnel" cmd /k "C:\Cloudflared\bin\cloudflared.exe tunnel run %TUNNEL_NAME%"
