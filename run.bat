@echo off
cd /d "%~dp0"
echo.
echo  ╔══════════════════════════════════════════╗
echo  ║   SHAKER - نظام إدارة المبيعات          ║
echo  ╚══════════════════════════════════════════╝
echo.
echo  اول مره؟ افتح setup-admin.html
echo  بعدها افتح login.html
echo.
start "" login.html
timeout /t 2 >nul
