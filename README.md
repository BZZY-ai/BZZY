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
