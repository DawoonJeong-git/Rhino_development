@echo off
setlocal
cd /d "C:\SpaceWork_deploy"
powershell -NoProfile -ExecutionPolicy Bypass -File "deploy\update-home-prod.ps1"
if errorlevel 1 (
  echo.
  echo Git pull and deploy failed.
  pause
  exit /b 1
)
echo.
echo Git pull and deploy completed.
echo Main: https://spaceswork.net/main
endlocal
