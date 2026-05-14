@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto no_node

set "URL=%~1"
set "GROUP=%~2"

if "%URL%"=="" set /p "URL=Please input article URL: "
if "%GROUP%"=="" set /p "GROUP=Please input material group: "

echo.
echo RUN
echo URL=%URL%
echo GROUP=%GROUP%
echo.

node "%~dp0scripts\backend-material-upload-cli.js" "%URL%" "%GROUP%"
set "EXIT_CODE=%ERRORLEVEL%"

echo.
if "%EXIT_CODE%"=="0" echo DONE
if not "%EXIT_CODE%"=="0" echo FAILED: %EXIT_CODE%
exit /b %EXIT_CODE%

:no_node
echo ERROR: Node.js not found. Please install Node.js first.
exit /b 1
