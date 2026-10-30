# Install BZZY CLI and Core

## macOS 15+ — Apple Silicon or Intel

```bash
# Use a GitHub account with access to BZZY-ai/BZZY.
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"

if ! command -v brew >/dev/null 2>&1; then
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
fi &&
brew install git python3 gh &&
gh auth login --hostname github.com --git-protocol https --web &&
gh auth setup-git --hostname github.com &&
mkdir -p "$HOME/Developer" &&
git clone https://github.com/BZZY-ai/BZZY.git "$HOME/Developer/BZZY" &&
bash "$HOME/Developer/BZZY/BZZY-CLI/BZZY-CLI-TERMINAL/install.sh" &&
export PATH="$HOME/.local/bin:$PATH" &&
mkdir -p "$HOME/BZZY-Workspace" &&
cd "$HOME/BZZY-Workspace" &&
bzzy

# Keep ~/Developer/BZZY: the installed launchers and Core service use it.
# Opening bzzy starts Core's supervised background service automatically.
```

## Debian 12+ / Ubuntu 24.04+ — x86_64 or ARM64

```bash
# Run as your normal user; sudo is only for installing system packages.
# Use a GitHub account with access to BZZY-ai/BZZY.
sudo apt-get update &&
sudo apt-get install -y git python3 curl ca-certificates openssl bubblewrap gh &&
gh auth login --hostname github.com --git-protocol https --web &&
gh auth setup-git --hostname github.com &&
mkdir -p "$HOME/Developer" &&
git clone https://github.com/BZZY-ai/BZZY.git "$HOME/Developer/BZZY" &&
bash "$HOME/Developer/BZZY/BZZY-CLI/BZZY-CLI-TERMINAL/install.sh" &&
export PATH="$HOME/.local/bin:$PATH" &&
mkdir -p "$HOME/BZZY-Workspace" &&
cd "$HOME/BZZY-Workspace" &&
bzzy

# Keep ~/Developer/BZZY: the installed launchers and Core service use it.
# Opening bzzy starts Core's supervised background service automatically.
```
