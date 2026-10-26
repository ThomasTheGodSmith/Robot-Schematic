@echo off
rem Double-click to start the Robot Design Engine. Close this window to stop it.
title Robot Design Engine
cd /d "%~dp0"

where npm >nul 2>nul
if errorlevel 1 (
  if exist "%ProgramFiles%\nodejs\npm.cmd" (
    set "PATH=%ProgramFiles%\nodejs;%APPDATA%\npm;%PATH%"
  ) else (
    echo Node.js was not found. Install it from https://nodejs.org and try again.
    pause
    exit /b 1
  )
)

if not exist "node_modules" (
  echo Installing dependencies, this only happens the first time...
  call npm install
  if errorlevel 1 (
    echo npm install failed.
    pause
    exit /b 1
  )
)

if not exist ".env" copy ".env.example" ".env" >nul

rem Open the web app in the browser once the dev server has had a few seconds to start.
if not defined NO_BROWSER start "" cmd /c "timeout /t 6 /nobreak >nul & start http://localhost:5173"

echo Starting... the web app will open at http://localhost:5173
echo Close this window to stop the app.
echo.
call npm run dev

echo.
echo The app has stopped.
pause
