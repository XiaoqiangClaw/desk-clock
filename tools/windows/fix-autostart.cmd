@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
echo.
echo  Desk Clock 开机自启 - 诊断与一键修复
echo  正在以当前用户身份运行（不会请求管理员权限）...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0fix-deskclock-autostart.ps1"
if errorlevel 1 (
  echo.
  echo [错误] PowerShell 运行失败，错误码 %errorlevel%
  pause
)
endlocal
