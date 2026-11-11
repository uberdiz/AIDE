# What changed, and what to test

Launch the development build with `npm run dev -- C:\python\tests`. It loads the new code from source. `runtime/AIDE.exe` still has the old version until you run `npm run package`.

Unit tests: `npm test` (90 tests, all passing). The items below have **not** been checked by hand in the running app yet.

## 1. Auto agent + auto model
- [ ] Type `make a calculator app with a UI` in a new chat. Before you send, the composer should show `→ Coder`. The reply should be labelled **Coder** with an `auto` badge, and it should use `llama3.1` (the 8B model).
- [ ] Type `what does calc.py do?`. It should go to **Chat** using the small model (`llama3.2:1b`).
- [ ] Try `fix the bug in calc.py` (should go to the Debugger), `plan a todo app` (Planner), `write tests for calc.py` (Tester) and `review my changes` (Reviewer).
- [ ] Force an agent with `/code`, `/plan`, `/debug`, `/review`, `/test` or `/docs`. Typing `/` opens the list.
- [ ] Hover the `auto` badge to see why that agent and model were chosen.
- [ ] Short follow-ups such as `yes` or `use tkinter instead` should stay with the previous agent.

## 2. Model menu and routing settings
- [ ] Click the model pill in the composer. It should list Auto (showing the chat and code models), checkboxes for which providers Auto may use, and every model. Picking a model uses it for everything.
- [ ] Open **AIDE Settings → Routing**. It should show the provider checkboxes and a dropdown per role (Chat, Coding, Planning, Review, Debugging, Inline edits, Autocomplete...). Each dropdown shows `Auto → <model>` or lets you pick a specific model.
- [ ] **Important:** your current settings pin chat to `smollm2:360m`, coding to `llama3.2:1b` and planning to `llama3.1`. Those rules override Auto. Set these rows to **Auto** and save, otherwise coding stays on the 1B model.
- [ ] There should be a suggestion to pull `qwen2.5-coder:7b`. It never downloads by itself.

## 3. Agent reliability (the calculator problems)
- [ ] `make a new python file named calc` should create `calc.py`, not `calc`. A file without an extension now gets one automatically.
- [ ] Editing should work even when the model copies the text slightly wrong: matching now ignores whitespace, and a failed edit shows the model the real file.
- [ ] Commands run in the workspace root. A wrong `cwd` gives a clear message. There's no more "lint test calc": verification is `python -m py_compile`.
- [ ] If the agent repeats the same failing action 3 times, it stops.
- [ ] Tool-call JSON printed as text no longer appears in the chat.

## 4. Chat functions
Hover over a message to see these:
- [ ] Copy.
- [ ] Edit and resend. There's an option to undo file changes made after that message.
- [ ] Branch (continue from that point in a new chat).
- [ ] Revert to before that message (optionally undoing files). The text goes back into the input box.
- [ ] Regenerate. It asks first if files would be undone.
- [ ] `···` menu → **Copy chat as Markdown**, **Open chat log**, **Memory**, **Personal memory**, and the agent mode (Auto or always one agent).

## 5. Pasting, file links, terminal
- [ ] Paste a long terminal output or traceback. It should become a compact `Terminal output · N lines` block (click it to preview) instead of flooding the chat.
- [ ] Type or paste `calc.py` or `C:\python\tests\calc.py`. A **Link file** suggestion should appear, and pasted paths become `@file:` links. Files named in plain text are also added as context automatically.
- [ ] `@output:` should list Output-panel logs (Git, Python, ...).
- [ ] Select text in a terminal and press **Ctrl+Alt+L**. It should be added to the chat as a block. With no selection, it adds the last command's output.
- [ ] The terminal button in the composer opens a chat terminal. Run `python calc.py`, then click the chat-bubble icon to attach the output. A **Run** button appears next to changed files.
- [ ] `run_command` output streams live inside the tool row.

## 6. Running scripts, extensions, logs, memory
- [ ] Opening a `.py` file without the Python extension should offer to install `ms-python.python`. Agents can also install extensions, with your approval.
- [ ] **Ctrl+Alt+R** or the ▶ button runs the current script. If Python is missing, it offers a winget install.
- [ ] `remember that I use tkinter for GUIs` should save to `.aide/memory.md`. Personal memory is in `~/.aide/memory.md`.
- [ ] Chat logs are in `~/.aide/logs/chats/*.md`, plus the **AIDE Chat** output channel.

## 7. Inline editor AI
- [ ] **Ctrl+Alt+.** should now keep indentation and only rewrite a few lines around the error.
- [ ] Results from **Ctrl+Alt+I → Generate code here** should appear in chat history (a ✦ entry), with an **Open in Chat** button.

## 8. Look
- [ ] Check that the new AIDE Dark/Light themes (VS Code Modern style with red accents) and the chat layout look right: centered input box, rounded composer, compact tool rows, hover actions.
- [ ] The extension icon should now be your `AIDE_Logo.png`.

## Not done yet
- `AIDE.exe`, the window/title-bar icon, the empty-editor watermark and the Start tile still show VSCodium's logo.
- There is no Setup `.exe` installer yet.
- The integration suite has not been re-run, and there has been no manual walkthrough in the running app.
