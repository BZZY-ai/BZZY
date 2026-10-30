# Requirements and platform setup

The same installer installs BZZY CLI and Core together. Clone the complete
repository so `BZZY-CORE`, `BZZY-RELAY` and `BZZY-CLI` remain beside each other.
The public repository can be cloned without GitHub CLI or a GitHub login.

## Supported hosts

| Platform | Version | Architecture |
| --- | --- | --- |
| macOS | 15+ for CLI and Core together | Apple Silicon or Intel |
| Debian | 12+ | ARM64 or x86_64 |
| Ubuntu | 24.04+ | ARM64 or x86_64 |

These are platform targets; see [platform validation](BZZY-CORE/docs/PLATFORMS.md)
for tested configurations and native isolation requirements.

## Required software

- Git.
- Python 3.9+ available as `python3`.
- `curl`, trusted HTTPS certificates, `tar`, and `sha256sum` or `shasum` for the
  private runtime download when needed.
- Node.js 24+ with npm. The installer uses a compatible existing installation
  or downloads and checksum-verifies a private Node 24 runtime automatically.

The installer checks Python first and does not install operating-system packages.
Install only the prerequisites your machine is missing.

### macOS

Homebrew is optional. If you already use [Homebrew](https://brew.sh/), Git and
Python can be installed with:

```bash
brew install git python3
```

Apple Command Line Tools can provide Git (`xcode-select --install`). Python is
also available from [python.org](https://www.python.org/downloads/macos/).

### Debian and Ubuntu

```bash
sudo apt-get update &&
sudo apt-get install -y git python3 curl ca-certificates
```

For enforced task isolation and optional shell HTTPS capture:

```bash
sudo apt-get install -y bubblewrap openssl
```

Linux enforced task policies require working user namespaces and bubblewrap.
macOS uses its native `sandbox-exec`. Strict modes stop if enforcement is
unavailable; BZZY does not disable host security controls.

## Installation location and first launch

Run the installer as your normal user. Dedicated Linux root installations use
the separate [explicit root setup](BZZY-CORE/docs/HOST-SERVICE.md#explicit-linux-root-installation).
Keep the cloned repository on a persistent disk: the installed launchers and
service refer to it.

The installer adds `~/.local/bin` to supported shell profiles if needed. For
the terminal in which you just installed, use:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

Run `bzzy` from your project directory. It starts Core's supervised background
service automatically. macOS uses launchd while the user is logged in and the
Mac is awake; Debian/Ubuntu use a systemd user service. Linux operation after
logout can require administrator-enabled lingering. See [Core service setup](BZZY-CORE/docs/HOST-SERVICE.md).

Configure your own model provider after installation. Codex/Claude executables,
when selected, are installed and authenticated separately; the BZZY installer
does not install them or copy another user's account credentials.
