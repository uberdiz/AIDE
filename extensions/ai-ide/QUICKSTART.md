# Quick Start Guide

## Running the AI IDE Extension

### Method 1: Press F5 (Recommended)
1. Open this workspace in VS Code
2. Press **F5**
3. A new VS Code window will open with the extension loaded

### Method 2: Using Run and Debug
1. Open Run and Debug panel (Ctrl+Shift+D)
2. Select "Run AI IDE Extension" from dropdown
3. Click the green play button or press F5

### Method 3: Command Line
```bash
# From the AIDE-main directory
cd extensions/ai-ide
npm install
npm run compile

# Then press F5 in VS Code
```

## First Time Setup

### 1. Configure an Agent Group

After the extension loads, configure your first agent group:

1. Press `Ctrl+,` to open Settings
2. Search for "ai-ide"
3. Click "Edit in settings.json"
4. Add this configuration:

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
            "apiKey": "YOUR_OPENAI_API_KEY_HERE"
          }
        },
        {
          "name": "coder",
          "role": "Code implementation",
          "provider": "openai",
          "model": "gpt-4",
          "settings": {
            "apiKey": "YOUR_OPENAI_API_KEY_HERE"
          }
        }
      ]
    }
  ]
}
```

### 2. Open the AI Chat

Press `Ctrl+L` (or `Cmd+L` on Mac) to open the AI chat panel.

### 3. Try It Out

Type a request like:
- "Create a REST API with Express"
- "Add authentication to my app"
- "Write tests for this function"

The AI will generate a plan, which you can review and approve before execution.

## Using Local Models (Ollama)

If you prefer to run models locally:

1. Install Ollama: https://ollama.ai
2. Pull a model: `ollama pull qwen2.5-coder`
3. Configure the agent group:

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

## Keyboard Shortcuts

- `Ctrl+L` - Open AI Chat
- `Ctrl+Shift+L` - Add selected code to chat
- `F5` - Run extension (when in development)

## Troubleshooting

### Extension doesn't load
- Check Output panel (View → Output → Extension Host)
- Ensure all dependencies are installed: `npm install`
- Recompile: `npm run compile`

### No agents available
- Configure at least one agent group in settings
- Ensure API keys are set correctly

### Ollama connection failed
- Start Ollama server: `ollama serve`
- Verify URL: `http://localhost:11434`

## Next Steps

- Read the full [README.md](./README.md) for detailed documentation
- Explore agent group configurations
- Try different execution modes (Plan vs Quick)
- Customize agent roles and prompts
