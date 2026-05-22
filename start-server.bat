@echo off
cd /d "%~dp0"
echo.
echo ============================================
echo  Copper Rush - Local Dev Server
echo ============================================
echo.
echo Open in browser:
echo   http://localhost:8000/copper-beta.html
echo   http://localhost:8000/prize-pool.html
echo.
echo Press Ctrl+C in this window to stop.
echo ============================================
echo.
python -m http.server 8000
pause
