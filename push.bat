@echo off
cd /d "%~dp0"
echo Adding all changes...
git add .
echo Committing...
git commit -m "Instant push" 2>nul
echo Pushing to GitHub...
git push
echo.
pause