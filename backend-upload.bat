@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] 未检测到 Node.js，请先安装 Node.js。
  pause
  exit /b 1
)

set "URL=%~1"
set "GROUP=%~2"

if "%URL%"=="" set /p "URL=请输入文章链接: "
if "%GROUP%"=="" set /p "GROUP=请输入素材分类名: "

echo.
echo [RUN]
echo URL: %URL%
echo GROUP: %GROUP%
echo.

node "%~dp0scripts\backend-material-upload-cli.js" "%URL%" "%GROUP%"
set "EXIT_CODE=%ERRORLEVEL%"

echo.
if "%EXIT_CODE%"=="0" (
  echo [DONE] 执行成功。
) else (
  echo [FAILED] 执行失败，退出码: %EXIT_CODE%
)
pause
exit /b %EXIT_CODE%
