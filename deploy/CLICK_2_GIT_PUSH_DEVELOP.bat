@echo off
setlocal
cd /d "C:\SpaceWork_develop"

for /f "delims=" %%i in ('git branch --show-current') do set "BRANCH=%%i"
if "%BRANCH%"=="" set "BRANCH=main"

echo [1/3] Staging changes in C:\SpaceWork_develop ...
git add -A
if errorlevel 1 goto :error

git diff --cached --quiet
if errorlevel 2 goto :error
if errorlevel 1 goto :commit

echo [2/3] No local changes to commit.
goto :push

:commit
for /f "delims=" %%i in ('powershell -NoProfile -Command "Get-Date -Format ''yyyy-MM-dd HH:mm:ss''"') do set "STAMP=%%i"
echo [2/3] Creating commit...
git commit -m "Develop sync %STAMP%"
if errorlevel 1 goto :error

:push
echo [3/3] Pushing to %BRANCH% ...
git push origin %BRANCH%
if errorlevel 1 goto :error

echo.
echo Git push completed from C:\SpaceWork_develop.
goto :end

:error
echo.
echo Git push failed.
pause
exit /b 1

:end
endlocal
