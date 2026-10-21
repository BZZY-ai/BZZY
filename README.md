# bzzy 🐝

```bash
git clone https://github.com/m4ke-a-wish/bzzy-cli.git
cd bzzy-cli
./install.sh
bzzy
```

Update:

```bash
bzzy --update
```

Check your Claude and Codex connections:

```bash
bzzy doctor
bzzy doctor --live
bzzy doctor --live --provider codex --model gpt-5.6-sol --effort high
```

`doctor` checks the installed CLI, subscription login and backend connection separately. `--live` also requests a short reply and reports token usage when the backend supplies it. Live checks use subscription tokens, disable tools and time out after 45 seconds waiting for a reply. Run `/doctor` inside chat to test its current subscription model, including while a reply is stuck. First-run setup checks both connections and tests the chosen subscription model before saving your default.

Claude login, model discovery, chat and diagnostics preserve the same credential settings on macOS and Linux. On macOS, leaving `CLAUDE_CONFIG_DIR` unset is significant: explicitly setting it to `~/.claude` can select a different Keychain entry ([upstream report](https://github.com/anthropics/claude-code/issues/92252)).

Ordinary chat does not snapshot the workspace. Explicit goals still create a complete source snapshot and identify any file exceeding the snapshot limit. Enforced task policies currently require Linux bubblewrap.

`/pause` stops the current response, including an unresponsive runner or backend, and keeps the conversation available for another message. The runtime refreshes after source or provider-environment changes. Runner startup failures appear in chat and include a private execution-log path. Claude's model picker reads the installed CLI's catalog, and chat displays the model reported by the backend.
