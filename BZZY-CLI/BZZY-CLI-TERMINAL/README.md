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

`/pause` stops the current response, including an unresponsive runner or backend, and keeps the conversation available for another message. The runtime refreshes after source updates. Runner startup failures appear in chat and include a private execution-log path. Claude's model picker reads the installed CLI's catalog, and chat displays the model reported by the backend.

Each execution receives its caller's environment; opening terminals with different PATHs or API keys does not restart the shared runtime. Runtime source updates still refresh it. Transient local API disconnections retry automatically.

Multi-agent modes (`--delegate`, `--besties`, `--parallel`, `--debate`) currently require working Linux bubblewrap isolation. On macOS they fail before model execution with an explanation. Ordinary solo chat/goals work without this enforcement layer; explicit enforced policies require a supported sandbox.

Optional settings in `~/.bzzy/config.json` (or `$BZZY_HOME/config.json`):

```json
{
  "inputTimeoutSeconds": 600,
  "bestiesMaxExchanges": 6,
  "snapshotLimits": {
    "maxFileMiB": 20,
    "maxTotalMiB": 100,
    "maxFiles": 10000
  }
}
```

Merge these keys into your existing configuration. Unanswered approvals expire denied. Besties pauses after the feedback exchange limit; `/goal resume` starts another bounded exchange. Snapshot limits can be raised without omitting files; evidence artifacts retain their separate 20 MiB limit. Snapshot and worker copies use filesystem copy-on-write when available. History and evidence remain saved without automatic pruning.

Peer edits stay in their private workspaces until integrated. A group with unapplied changes remains awaiting review and reports each workspace path and changed files. `/providers` changes the conversation; `/default` saves the launch default. Switching providers carries recent bounded context; the full history remains saved.

For runtime troubleshooting, run `BZZY_DIRECT=1 bzzy run "Reply only BZZY_OK without using tools" --claude --runtime 30 --json` to test the backend without the managed runtime. Replace `--claude` with `--codex` or `--deepseek` as needed.

The [review assessment](docs/REVIEW-2026-10.md) records which external recommendations were implemented, qualified or deferred.
