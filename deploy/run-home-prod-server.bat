@echo off
set "PRODROOT=C:\SpaceWork_deploy"
if not exist "%PRODROOT%" set "PRODROOT=C:\Rhino_deploy"
cd /d "%PRODROOT%"
powershell -NoExit -ExecutionPolicy Bypass -File "deploy\start-server.ps1"
