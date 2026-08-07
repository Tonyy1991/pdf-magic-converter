@echo off
chcp 65001 >nul
title PDF Magic Converter
cd /d "%~dp0"

echo ========================================
echo   PDF Magic Converter
echo   http://localhost:8017
echo ========================================
echo.
echo กำลังเปิดเบราว์เซอร์... (ปิดหน้าต่างนี้ = ปิดเซิร์ฟเวอร์)
echo.

start "" "http://localhost:8017"

where python >nul 2>nul
if %errorlevel%==0 (
    python -m http.server 8017
) else (
    py -m http.server 8017
)
