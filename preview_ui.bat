@echo off
setlocal
title YOLO Auto-Tag UI Preview
cd /d "%~dp0"

where python.exe >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Python was not found in PATH.
    echo Install Python and try again.
    echo.
    pause
    exit /b 1
)

python.exe "%~dp0desktop\preview_ui.py" %*
set "PREVIEW_EXIT=%ERRORLEVEL%"
if not "%PREVIEW_EXIT%"=="0" (
    echo.
    echo [ERROR] Preview failed with exit code %PREVIEW_EXIT%.
    echo Review the error output above.
    pause
)
endlocal
exit /b %PREVIEW_EXIT%
