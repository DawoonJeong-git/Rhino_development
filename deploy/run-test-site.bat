@echo off
set "DEVROOT=%~dp0.."
set "PORT=3001"
set "ROUTE_BASE_PATH=/test"
cd /d "%DEVROOT%"
powershell -ExecutionPolicy Bypass -File "deploy\start-server.ps1" -Managed
if errorlevel 1 exit /b %errorlevel%
