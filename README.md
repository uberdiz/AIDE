# AIDE 2.0

An AI-native IDE for Windows. It's a complete IDE on its own, and the AI is built into it.

- **The IDE** is a rebranded VSCodium 1.107 workbench, carried over from AIDE 1.x. That gives you the editor, tabs, split groups, multi-cursor, search and replace, integrated terminals, Git, a debugger (DAP), language servers, the extension marketplace (Open VSX), settings, keybindings, themes and profiles. None of it needs AI.
- **The AI platform** is `extensions/aide-core`, a new built-in extension. It adds multi-provider routing, agents, MCP, the context engine, usage limits, change review and checkpoints, GitHub, connectors, workflows and the extension builder.

## Quick start

```bash
npm install          # dev dependencies (esbuild, TypeScript, vitest, SDKs)
npm run setup        # prepare runtime/ (copies ../AIDE, or: node scripts/setup-runtime.mjs --download)
npm run package      # build aide-core, install it into runtime/, produce dist/AIDE-2.0-win32-x64.zip
npm start            # launch AIDE (runtime/AIDE.exe)
```

You can also double-click `runtime/AIDE.exe`, or run `AIDE.cmd <folder>`.

| Script | What it does |
| --- | --- |
| `npm run dev [-- <folder>]` | Build, then launch AIDE with aide-core loaded from source, using an isolated `.dev/` profile |
| `npm run watch` | Rebuild on change (reload the window with `Developer: Reload Window`) |
| `npm run build` | Bundle the extension and webviews into `extensions/aide-core/dist` |
| `npm run typecheck` | TypeScript strict check |
| `npm test` | Unit tests (vitest). Includes mock-server tests for every provider, plus a live Ollama test when it's running |
| `npm run test:integration` | Runs the integration suite inside the real AIDE app in an isolated sandbox, then restarts it to verify persistence |
| `npm run package` | Production build, installs into `runtime/`, and creates `dist/AIDE-2.0-win32-x64(.zip)` |

`runtime/` is a portable install: your settings, extensions and state live in `runtime/data/`. The test and dev scripts point `VSCODE_PORTABLE` at their own folders, so they never touch that profile.

## First steps in AIDE

1. **AIDE: Open AI Settings → Providers**. Ollama (local) is preconfigured. Add Anthropic, OpenAI, Gemini, OpenRouter, LM Studio, llama.cpp, vLLM or any OpenAI-compatible endpoint. Keys go into the OS keychain.
2. **Routing**: pick models per task (chat, coding, planning, autocomplete, vision...) with fallbacks. Inline completions only run once you set an `autocomplete` rule.
3. **Ctrl+Shift+A** opens the chat. Choose an agent (Chat, Coder, Planner, Debugger, Reviewer, Tester, Documenter, Coder (Git & GitHub), Extension Builder, or your own) and add context with `@file:`, `@folder:`, `@selection`, `@errors`, `@terminal`, `@git`, `@workspace`, `@symbol:` or `@doc:`.
4. Review what agents changed under **AIDE → AI Changes** (per file, or per hunk with CodeLens), or **Restore** a checkpoint.

## Keyboard shortcuts

| Keys | Action |
| --- | --- |
| Ctrl+Shift+A | Focus AI chat |
| Ctrl+Alt+I | AI actions on selection (explain, refactor, fix, docs, types, translate, tests, regex, SQL...) |
| Ctrl+Alt+K | Edit selection with an instruction (diff preview first) |
| Ctrl+Alt+E | Explain selection |
| Ctrl+Alt+L | Add selection to chat |
| Ctrl+Alt+. | Fix the problem at the cursor |
| Ctrl+Alt+W | Run a workflow |
| Ctrl+Alt+Backspace | Stop all AI operations |

Standard IDE shortcuts work as in VS Code: Ctrl+P, Ctrl+Shift+P, Ctrl+Shift+F, Ctrl+`, Ctrl+B, F5 and so on. All of them are remappable under Keyboard Shortcuts.

## Project files (`.aide/`)

```
.aide/instructions.md   rules sent to every agent (AGENTS.md, CLAUDE.md, .cursorrules are read too)
.aide/memory.md         facts agents record - plain Markdown, edit freely
.aide/rules/*.md        extra rule files
.aide/agents/*.md|yaml  custom agents (YAML front matter + instructions)
.aide/workflows/*.yaml  workflows
.aide/plans/            plans written by the Planner agent
.aide/context/          generated project map (AI: Analyze Project)
.aide/mcp.json          project MCP servers (user-level: ~/.aide/mcp.json)
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the pieces fit together.
