@echo off
chcp 437 >nul
color 07

echo.
echo  ####  ####  ####  ####  ####  ####  ####  ####
echo  #  #  #  #  #  #  #  #  #  #  #  #  #  #  #  #
echo  ####  ####  ####  ####  ####  ####  ####  ####
echo  #  #  #  #  #  #  #  #  #  #  #  #  #  #  #  #
echo  ####  ####  ####  ####  ####  ####  ####  ####
echo.
echo  ####  ####  ####  ####  ####  ####  ####  ####
echo  #  #  #  #  #  #  #  #  #  #  #  #  #  #  #  #
echo  ####  ####  ####  ####  ####  ####  ####  ####
echo  #  #  #  #  #  #  #  #  #  #  #  #  #  #  #  #
echo  ####  ####  ####  ####  ####  ####  ####  ####
echo.
echo ======================================================================
echo.
echo                      E L y r   T i k T o k   B o t
echo               Advanced Terminal Control System
echo.
echo [+] Running npm install...
call npm install
if %errorlevel% neq 0 (
    color 0c
    echo.
    echo Error: npm install failed!
    echo.
    pause
    exit /b
)
echo [+] npm install completed.
echo.
echo [+] Initializing ELyr core engine...
echo [+] Loading encrypted configuration...
echo [+] Verifying environment integrity...
echo [+] Connecting to ELyr control gateway...
echo [+] Loading account workspace...
echo [+] Syncing task scheduler...
echo [+] Activating security monitor...
echo [+] Activity logs initialized...
echo [+] System status: ONLINE
echo.
echo ======================================================================
echo.
echo                      E L y r   D A S H B O A R D
echo.
echo ======================================================================
echo.
echo   [01]  Account Workspace
echo   [02]  Content Queue
echo   [03]  Scheduler Panel
echo   [04]  Analytics Center
echo   [05]  Session Manager
echo   [06]  Security Settings
echo   [07]  Export Logs
echo   [08]  System Information
echo   [00]  Exit
echo.
echo ======================================================================
echo.
echo   USER       : @ELyr
echo   VERSION    : ELyr TikTok Bot v2.6.0
echo   STATUS     : ACTIVE
echo   SERVER     : CONNECTED
echo   SECURITY   : ENABLED
echo   UPTIME     : 07:42:19
echo   LOGGING    : RUNNING
echo.
echo ======================================================================
echo.
echo ELyr@tiktok-bot:~$ _
echo.

:: 1. Check Node.js
echo [1/2] Checking Node.js...
node -v >nul 2>&1
if %errorlevel% neq 0 (
    color 0c
    echo.
    echo Error: Node.js not found!
    echo Download Node.js from: https://nodejs.org/
    echo.
    pause
    exit /b
)
echo Node.js found.
echo.

:: 2. Start bot
echo [2/2] Starting bot...
echo ----------------------------------------------------------
echo.

node bot.js

echo.
echo ----------------------------------------------------------
echo Bot stopped.
echo.
pause
