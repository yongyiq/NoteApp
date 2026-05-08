@echo off
REM build-frontend.bat — 构建前端到 dist/ 目录
REM 供 tauri.conf.json 的 beforeBuildCommand 调用

setlocal enabledelayedexpansion

if not exist "dist" mkdir dist

REM 复制静态文件
copy /Y index.html dist\ >nul
copy /Y style.css dist\ >nul
copy /Y app.js dist\ >nul
copy /Y web-storage.js dist\ >nul

REM 复制 lib 目录（marked, highlight.js, pdfjs）
if not exist "dist\lib" mkdir dist\lib
robocopy /E /NP /NJH /NJS lib dist\lib >nul 2>&1

echo Frontend built to dist/
endlocal
