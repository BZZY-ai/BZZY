# OrcaRouter, with Cyber models first

`orcarouter` is a built-in API-key provider using the installed Codex adapter and
`https://api.orcarouter.ai/v1/responses`. OrcaRouter documents Responses support
for all chat models, including translated upstream formats; see its
[HTTP API](https://docs.orcarouter.ai/native-formats/openai-compat).

After updating CLI/Core through the TUI, enter your key through the hidden prompt:

```sh
bzzy auth orcarouter
bzzy --provider orcarouter --model orca/orcacyber-zero-1.5
```

`ORCAROUTER_API_KEY` is the alternative host environment setting. Keys remain in
private host storage/the selected API backend environment. Core strips this key
from subscription backends and tool environments. Never put it in a skill,
conversation, project export or source file.

The provider default is **OrcaCyber Zero 1.5**. The authenticated `/v1/models`
catalog remains authoritative for discovery: available Cyber models appear first,
followed by other chat models. New OrcaCyber IDs and models marked Cyber by the
catalog participate automatically. Image/video generation, embeddings, audio-only,
locked, unready and delisted entries are excluded from this chat selector.
Core preserves the same Cyber-first order across iPhone model pages.

Known text-only model context defaults are:

| Model | Context tokens |
| --- | ---: |
| `orca/orcacyber-zero-1.5` | 1,000,000 |
| `orca/orcacyber-zero-1.0` | 1,000,000 |
| `orca/orcacyber-ultra-1.0` | 1,048,576 |

These follow the public model cards for [Zero 1.5](https://www.orcarouter.ai/models/orca/orcacyber-zero-1.5),
[Zero 1.0](https://www.orcarouter.ai/models/orca/orcacyber-zero-1.0) and
[Ultra 1.0](https://www.orcarouter.ai/models/orca/orcacyber-ultra-1.0).
Known Cyber profiles expose low/medium/high reasoning, matching the router's
[unified reasoning controls](https://docs.orcarouter.ai/advanced/reasoning).
Live context, modality and effort metadata override these defaults. Manual IDs
are supported; a configured default/profile is not evidence of account access.

Cyber access requires the workspace's **Security Research** grant, and per-member
requirements can also apply. OrcaRouter omits Cyber models from `/v1/models` for
keys without the tier and can reject a listed model at execution time. BZZY shows
an access explanation when no Cyber models are listed; it does not add public
model cards as entitled models or fall back to another model after denial.
Complete account setup in the [OrcaRouter portal](https://docs.orcarouter.ai/getting-started/cyber-models).

Core's independent default assistant can use this provider through
`bzzy-core assistant set orcarouter --model orca/orcacyber-zero-1.5 --effort high`.
Existing shared skills, verified goals, approval rules and persistent Agent
isolation use the same Core path. Model category metadata grants no authority.

Validation uses synthetic keys and an isolated HTTP catalog to check discovery,
ordering/pagination, new Cyber IDs, access denial, metadata and credential
separation. Live inference needs the user's own approved workspace/key.
