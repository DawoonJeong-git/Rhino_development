@echo off
setlocal

echo [1/2] Starting main web on https://spaceswork.net/main
call "C:\SpaceWork_deploy\deploy\run-home-site.bat"
if errorlevel 1 goto :error

echo.
echo [2/2] Starting test web on https://spaceswork.net/test
call "C:\SpaceWork_develop\deploy\run-test-site.bat"
if errorlevel 1 goto :error

echo.
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
