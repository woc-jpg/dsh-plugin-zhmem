@echo off
chcp 936 >nul
title zhmem
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo [错误] 没有找到 Node.js
    echo.
    echo 这个程序需要 Node.js 22 或更高版本。
    echo 下载地址： https://nodejs.org/zh-cn/download
    echo 装完后重新双击本文件即可。
    echo.
    pause
    exit /b 1
)

for /f "tokens=1 delims=." %%v in ('node -p "process.versions.node"') do set NODEMAJOR=%%v
if %NODEMAJOR% LSS 22 (
    echo [错误] Node.js 版本太低，需要 22 以上。
    node -v
    pause
    exit /b 1
)

node launcher.js
if errorlevel 1 pause