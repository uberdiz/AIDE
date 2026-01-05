#!/bin/bash
# AI IDE Extension Launcher for Mac/Linux
# This script compiles and launches the AI IDE extension in VS Code

echo "========================================"
echo "AI IDE Extension Launcher"
echo "========================================"
echo ""

# Get script directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

# Navigate to extension directory
cd "$SCRIPT_DIR/extensions/ai-ide"

echo "[1/3] Installing dependencies..."
npm install
if [ $? -ne 0 ]; then
    echo "ERROR: Failed to install dependencies"
    exit 1
fi

echo ""
echo "[2/3] Compiling TypeScript..."
npm run compile
if [ $? -ne 0 ]; then
    echo "ERROR: Failed to compile"
    exit 1
fi

echo ""
echo "[3/3] Launching VS Code with AI IDE extension..."
echo ""
echo "A new VS Code window will open with the extension loaded."
echo "Press Ctrl+L (or Cmd+L on Mac) to open the AI Chat panel."
echo ""

# Launch VS Code with extension development host
cd "$SCRIPT_DIR"
code --extensionDevelopmentPath="$SCRIPT_DIR/extensions/ai-ide" .

echo ""
echo "========================================"
echo "Extension launched successfully!"
echo "========================================"
echo ""
echo "Next steps:"
echo "1. Configure your API key in VS Code settings"
echo "2. Press Ctrl+L (Cmd+L on Mac) to open AI Chat"
echo "3. Start coding with AI assistance!"
echo ""
