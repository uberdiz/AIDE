@echo off
REM AI IDE Extension Launcher for Windows
REM This script compiles and launches the AI IDE extension in VS Code

echo ========================================
echo AI IDE Extension Launcher
echo ========================================
echo.

REM Navigate to extension directory
cd /d "%~dp0extensions\ai-ide"

echo [1/3] Installing dependencies...
call npm install
if %errorlevel% neq 0 (
    echo ERROR: Failed to install dependencies
    pause
    exit /b 1
)

echo.
echo [2/3] Compiling TypeScript...
call npm run compile
if %errorlevel% neq 0 (
    echo ERROR: Failed to compile
    pause
    exit /b 1
)

echo.
echo [3/3] Launching VS Code with AI IDE extension...
echo.
echo A new VS Code window will open with the extension loaded.
echo Press Ctrl+L to open the AI Chat panel.
echo.

REM Launch VS Code with extension development host
cd /d "%~dp0"
code --extensionDevelopmentPath="%~dp0extensions\ai-ide" .

echo.
echo ========================================
echo Extension launched successfully!
echo ========================================
echo.
echo Next steps:
echo 1. Configure your API key in VS Code settings
echo 2. Press Ctrl+L to open AI Chat
echo 3. Start coding with AI assistance!
echo.
pause
