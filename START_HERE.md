# 🚀 AI IDE - Quick Start

## One-Click Launch

### Windows
Double-click **`run-ai-ide.bat`** in the AIDE-main folder.

Or from command line:
```cmd
run-ai-ide.bat
```

### Mac/Linux
```bash
chmod +x run-ai-ide.sh
./run-ai-ide.sh
```

---

## What the Launcher Does

1. ✅ Installs all dependencies
2. ✅ Compiles TypeScript code
3. ✅ Launches VS Code with the AI IDE extension

---

## After Launch

1. **Configure API Key**
   - Press `Ctrl+,` to open Settings
   - Search for "ai-ide"
   - Add your configuration:

```json
{
  "ai-ide.agentGroups": [
    {
      "name": "Default",
      "agents": [
        {
          "name": "planner",
          "role": "Planning and architecture",
          "provider": "openai",
          "model": "gpt-4",
          "settings": {
            "apiKey": "sk-your-api-key-here"
          }
        }
      ]
    }
  ]
}
```

2. **Open AI Chat**
   - Press `Ctrl+L` (or `Cmd+L` on Mac)

3. **Start Coding!**
   - Type: "Create a REST API with authentication"
   - AI will generate a plan
   - Review and approve
   - AI implements everything!

---

## Alternative: Use F5 in VS Code

If you already have the workspace open:
1. Open AIDE-main in VS Code
2. Press **F5**
3. Extension launches in new window

---

## Troubleshooting

### Script doesn't run
**Windows:**
```cmd
# Run as administrator
Right-click run-ai-ide.bat → Run as administrator
```

**Mac/Linux:**
```bash
# Make executable
chmod +x run-ai-ide.sh
./run-ai-ide.sh
```

### VS Code not found
Make sure VS Code is installed and `code` command is in PATH:
```bash
# Test if code command works
code --version
```

If not, install VS Code and enable shell command:
- Open VS Code
- Press `Ctrl+Shift+P`
- Type "Shell Command: Install 'code' command in PATH"

### Extension doesn't load
Check the Output panel:
- View → Output
- Select "Extension Host" from dropdown
- Look for error messages

---

## Using Local Models (Ollama)

For privacy or offline use:

1. **Install Ollama**
   ```bash
   # Visit https://ollama.ai
   # Download and install
   ```

2. **Pull a model**
   ```bash
   ollama pull qwen2.5-coder
   ```

3. **Configure in settings**
   ```json
   {
     "ai-ide.agentGroups": [
       {
         "name": "Local",
         "agents": [
           {
             "name": "coder",
             "role": "Code implementation",
             "provider": "ollama",
             "model": "qwen2.5-coder",
             "settings": {
               "apiUrl": "http://localhost:11434"
             }
           }
         ]
       }
     ]
   }
   ```

---

## Features

✅ **Multi-Provider Support**
- OpenAI (GPT-4, GPT-3.5)
- Ollama (Local models)
- HuggingFace
- Anthropic (Claude)
- Custom endpoints

✅ **Intelligent Context**
- Automatic file detection
- Project type recognition
- Dependency analysis
- Smart agent routing

✅ **Planning Workflow**
- Editable plans
- User review and approval
- Inline modifications

✅ **Change Management**
- Diff preview
- Approval gates
- Next steps guidance
- Click-to-run commands

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+L` / `Cmd+L` | Open AI Chat |
| `Ctrl+Shift+L` / `Cmd+Shift+L` | Add Selection to Chat |
| `F5` | Launch Extension (in development) |

---

## Documentation

- **[README.md](extensions/ai-ide/README.md)** - Full documentation
- **[QUICKSTART.md](extensions/ai-ide/QUICKSTART.md)** - Detailed setup guide

---

## Support

If you encounter issues:
1. Check the Output panel (View → Output → Extension Host)
2. Verify API keys are configured correctly
3. Ensure dependencies are installed: `npm install`
4. Recompile: `npm run compile`

---

**Happy Coding with AI!** 🎉
