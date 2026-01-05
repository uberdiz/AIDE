# AI IDE - VS Code Extension

An intelligent AI-powered development assistant with multi-agent system, context-aware code generation, and advanced planning capabilities.

## Features

### 🤖 Multi-Agent System
- **Planner Agent**: Creates detailed implementation plans
- **Coder Agent**: Implements code with best practices
- **Tester Agent**: Writes comprehensive tests
- **Custom Agent Groups**: Create unlimited groups with any provider mix

### 🔌 Multi-Provider Support
- **OpenAI** (GPT-4, GPT-3.5)
- **Ollama** (Local models)
- **HuggingFace** (Open source models)
- **Anthropic** (Claude)
- **Custom** (Any OpenAI-compatible endpoint)

### 🎯 Context-Aware Intelligence
- Automatic file detection from user requests
- Project type and framework detection
- Dependency analysis (Node.js, Python, Java, .NET, Go, Rust)
- Smart agent routing based on task type

### 📝 Planning System
- Editable planning documents
- User can review and modify AI plans before execution
- Inline comments and approval workflow

### 🔄 Change Management
- Diff preview before applying changes
- Approval gates for destructive actions
- Automatic "Next Steps" documentation
- Click-to-run commands

### 💬 Advanced Chat Interface
- Add selected code to chat with one click
- # mention system for files, directories, terminal output
- Plan vs Quick execution modes
- Chat history and rollback

## Quick Start

### 1. Install Dependencies
```bash
cd extensions/ai-ide
npm install
```

### 2. Configure API Keys
Open VS Code settings and configure your preferred provider:

```json
{
  "ai-ide.agentGroups": [
    {
      "name": "My Team",
      "agents": [
        {
          "name": "planner",
          "role": "Planning and architecture",
          "provider": "openai",
          "model": "gpt-4",
          "settings": {
            "apiKey": "sk-..."
          }
        }
      ]
    }
  ]
}
```

### 3. Run the Extension
Press **F5** in VS Code to launch the extension in a new window.

Or use the launch configuration:
1. Open Run and Debug (Ctrl+Shift+D)
2. Select "Run AI IDE Extension"
3. Press F5

## Usage

### Open AI Chat
- Press `Ctrl+L` (or `Cmd+L` on Mac)
- Or run command: "AI IDE: Open Chat"

### Add Code to Chat
1. Select code in editor
2. Press `Ctrl+Shift+L` or right-click → "Add to AI Chat"

### Create a Plan
1. Open chat
2. Type your request: "Add authentication to my Express app"
3. AI generates a detailed plan
4. Review and edit the plan
5. Approve to execute

### Switch Agent Groups
- Run command: "AI IDE: Switch Agent Group"
- Select from your configured groups

### Manage Agent Groups
- Run command: "AI IDE: Manage Agent Groups"
- Create custom groups with different providers

## Configuration

### Agent Group Example
```json
{
  "ai-ide.agentGroups": [
    {
      "name": "Full Stack Team",
      "description": "Complete development team",
      "agents": [
        {
          "name": "architect",
          "role": "System design and planning",
          "provider": "openai",
          "model": "gpt-4-turbo",
          "settings": {
            "apiKey": "sk-...",
            "temperature": 0.7,
            "maxTokens": 4000
          }
        },
        {
          "name": "coder",
          "role": "Implementation",
          "provider": "ollama",
          "model": "qwen2.5-coder:32b",
          "settings": {
            "apiUrl": "http://localhost:11434",
            "temperature": 0.3
          }
        },
        {
          "name": "tester",
          "role": "Quality assurance",
          "provider": "huggingface",
          "model": "codellama/CodeLlama-34b-Instruct-hf",
          "settings": {
            "apiKey": "hf_...",
            "temperature": 0.2
          }
        }
      ]
    }
  ]
}
```

### Settings

| Setting | Description | Default |
|---------|-------------|---------|
| `ai-ide.agentGroups` | Custom agent group configurations | `[]` |
| `ai-ide.executionMode` | Plan or quick execution | `"plan"` |
| `ai-ide.autoApprove` | Auto-approve agent actions | `false` |
| `ai-ide.enableSelectionPrompts` | Show "Add to Chat" on selection | `true` |
| `ai-ide.maxContextFiles` | Max files in context | `10` |
| `ai-ide.enableDependencyAnalysis` | Analyze dependencies | `true` |

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+L` / `Cmd+L` | Open AI Chat |
| `Ctrl+Shift+L` / `Cmd+Shift+L` | Add Selection to Chat |

## Architecture

```
ai-ide/
├── src/
│   ├── extension.ts           # Entry point
│   ├── agents/
│   │   ├── orchestrator.ts    # Agent coordination
│   │   ├── base-agent.ts      # Multi-provider agent
│   │   └── group-manager.ts   # Group management
│   ├── planning/
│   │   └── document-provider.ts # Editable plans
│   ├── execution/
│   │   └── change-manager.ts  # Apply changes
│   ├── ui/
│   │   ├── chat-panel.ts      # Chat interface
│   │   ├── selection-context.ts # Selection handling
│   │   ├── file-timeline.ts   # File history
│   │   └── mention-provider.ts # # autocomplete
│   ├── state/
│   │   └── session-manager.ts # State persistence
│   └── services/
│       ├── project-analyzer.ts # Project detection
│       └── dependency-analyzer.ts # Dependency parsing
```

## Development

### Build
```bash
npm run compile
```

### Watch Mode
```bash
npm run watch
```

### Package Extension
```bash
npm install -g @vscode/vsce
vsce package
```

This creates a `.vsix` file you can install in VS Code.

## Troubleshooting

### Extension Not Loading
1. Check the Output panel (View → Output)
2. Select "Extension Host" from dropdown
3. Look for error messages

### API Key Issues
- Ensure API keys are set in settings
- For Ollama, ensure server is running: `ollama serve`
- For custom providers, verify endpoint URL

### No Agents Available
1. Open settings (Ctrl+,)
2. Search for "ai-ide.agentGroups"
3. Configure at least one agent group

## License

MIT

## Contributing

Contributions welcome! Please open an issue or PR.
