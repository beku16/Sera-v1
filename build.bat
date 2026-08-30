@echo off
setlocal
echo ============================================================
echo   S E R A   -   Windows Desktop Build
echo ============================================================
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build.ps1" %*
if errorlevel 1 (
    echo.
    echo [ERROR] Build failed with exit code %errorlevel%.
    exit /b %errorlevel%
)
endlocal
