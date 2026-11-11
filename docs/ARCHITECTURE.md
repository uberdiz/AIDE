# AIDE 2.0 architecture

```
runtime/  VSCodium 1.107 workbench (rebranded "AIDE 2.0", portable)   <- the IDE
  editor, tabs/groups, search, terminal, Git SCM, debugger (DAP), LSP, Open VSX
  extensions, settings/keybindings/themes/profiles
  resources/app/extensions/aide-core   <- built-in AI platform (this repo)

extensions/aide-core/src
  ai/               provider-neutral AI core (no vscode imports, unit tested)
    types.ts          ChatMessage / ToolCall / StreamEvent / Provider interface
    providers/        anthropic (official SDK), openai + compatible, ollama, gemini, registry
    router.ts         task -> ordered candidates; aliases, strategies, capability/context filters
    client.ts         single gateway: routing, fallback, limits, usage, request log
    usage.ts          daily rollups, limits (daily/monthly/per-request/per-provider), warnings
    tokens.ts         estimation and pricing
    history.ts        history compaction (compress tool output -> summarize -> drop)
    context/          engine (strategies, budgets, dedup), mentions, ignore rules, repo map, compression
  agents/           definitions (built-in + .aide/agents + extensions), permissions, runtime loop
  tools/            tool registry + built-in tools (fs, search, terminal, git, diagnostics, web,
                    memory), debug tools (DAP), dev utilities
  changes/          diff/hunks, ChangeTracker (checkpoints + review)
  mcp/              MCP manager (stdio / streamable HTTP / SSE), isolated per server
  chat/             conversations store, ChatController (turns chat input into agent runs)
  github/ git/      GitHub client, view, agent tools; AI commit messages / PR descriptions
  connectors/       Connector API, GitHub + Google Drive connectors, view
  extensions/       public AideApi, extension builder (scaffold, run, VSIX pack, install)
  workflows/        workflows and automations
  inline/           inline completions, selection actions, error intelligence, AI code lens
  ui/               chat view, settings hub, usage/inspector panels, tree views, status bar, layouts
  webview/          browser-side code for the webviews (bundled with esbuild)
  services.ts       wires everything together per window
  extension.ts      activation
```

## Request flow

1. The chat (or a command, workflow or the API) calls `ChatController.send`.
2. `ContextEngine` builds a bundle within the strategy's budget: project instructions, explicit @mentions, selection, active file excerpt, diagnostics, retrieval hits (exact search first), and the repo map. It deduplicates anything already sent earlier in the conversation and never includes ignored or secret files. The UI shows this bundle as chips before you send.
3. `AgentRunner` loops: `AiClient.run` → model turn → tool calls → permission check → tool execution → next turn. Tool input is schema-validated. Paths are confined to the workspace. Dangerous commands always ask. The runner nudges the agent to verify after edits, and recovers JSON tool calls from local models that print them as text. Cancelling aborts both the HTTP stream and any child processes.
4. `AiClient` routes the request through the ordered candidates, applies usage limits before sending, falls back on failure, records usage, and writes a `RequestRecord` for the Context Inspector.
5. Every file write goes through `ChangeTracker`, which snapshots the original (the checkpoint) and tracks the pending diff for review.

## Extension points

Other extensions reach these through the AideApi returned by `activate()`: tools, agents, provider kinds and instances, connectors, workflows, `chat()`, `runAgent()` and `buildContext()`. MCP servers add tools without writing code. `.aide/agents` adds agents without code.

## Safety

- API keys and secrets live in SecretStorage (the OS keychain). They are never stored in settings, never sent to models, and never exported. MCP config refers to them as `${secret:name}`.
- Permissions are set per category (read, write, delete, command, network, git, github, external, mcp) as ask, allow or deny. An approval can be remembered for the session, the workspace, or always. Individual agents can override.
- Workspace MCP servers only start after an explicit trust prompt.
- Model-generated shell snippets in chat are pasted into a terminal, never executed.
