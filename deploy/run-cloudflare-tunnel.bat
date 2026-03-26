@echo off
set "TUNNEL_NAME=%~1"
if "%TUNNEL_NAME%"=="" set "TUNNEL_NAME=space-work-home"
C:\Cloudflared\bin\cloudflared.exe tunnel run %TUNNEL_NAME%
