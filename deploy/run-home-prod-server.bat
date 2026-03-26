@echo off
set "PRODROOT=C:\SpaceWork_deploy"
cd /d "%PRODROOT%"
powershell -ExecutionPolicy Bypass -File "deploy\start-server.ps1" -Managed
if errorlevel 1 exit /b %errorlevel%
