# Chat and agents

The AI chat lives in the secondary side bar (**Ctrl+Shift+A**).

- Pick an agent: **Chat** (read-only), **Coder**, **Planner**, **Debugger**, **Reviewer**, **Tester**, **Documenter**, or your own.
- Add context explicitly with `@file:path`, `@folder:path`, `@selection`, `@errors`, `@terminal`, `@git`, `@workspace`, `@symbol:Name`.
- The chips above the input show exactly what will be sent and how many tokens it costs. Remove any chip to leave that item out.
- Agents ask before they write files, run commands or use the network. Every change is checkpointed, and you can review it per file or per hunk in **AI Changes**.
- Press **Esc** or click **Stop** to cancel. Unfinished changes can be restored from the checkpoint.
