# Abliteration provider

`abliteration` is a built-in Core API-key provider. It uses the existing Codex
execution adapter with `https://api.abliteration.ai/v1` and the Responses wire
protocol, as described in [Abliteration's Codex integration](https://docs.abliteration.ai/integrations/codex).
The installed Codex CLI is still required. Core supplies private per-run
configuration; setup does not edit the user's Codex subscription configuration.

After updating CLI/Core through the TUI, authenticate through the hidden prompt:

```sh
bzzy auth abliteration
bzzy --provider abliteration --model abliterated-model
```

Alternatively, configure `ABLITERATION_API_KEY` in the host environment. Keys
remain in private host storage or the selected backend environment; never put
them in chat, a skill, source control or a shared project. Subscription backends
and Core tool environments exclude this credential.

The default model is `abliterated-model`. CLI/iOS discover the provider through
Core's existing registry. The model dropdown reads the authenticated project's
`GET /v1/models` catalog, including new model IDs, display names, `context_length`
and input modalities. Locked, unavailable or unready entries are excluded.
Manual model IDs remain supported. An unavailable catalog does not imply that
authentication or inference succeeded.

Core has Responses-specific capability defaults for these documented models:

| Model | Context | Effort choices |
| --- | ---: | --- |
| `abliterated-model` | 262,144 | none, minimal, low, medium, high, xhigh |
| `abliterated-model-large-flash` | 1,048,576 | none, low, high, max |
| `abliterated-model-large-v2` | 1,000,000 | low, high, max |
| `abliterated-model-large` (deprecated upstream) | 1,000,000 | none, high, max |

These reflect the upstream [model catalog](https://docs.abliteration.ai/models)
and [Responses reasoning contract](https://docs.abliteration.ai/capabilities/thinking).
Live capability metadata takes precedence. Defaults also apply to manual IDs
and the independent Core assistant, preventing base-model `max` requests and
Large V2 reasoning-off choices. Supported compatibility aliases that map to the
same reasoning mode are omitted from the large-model menus. `default` leaves
the selection to the adapter/model; it is distinct from `none`.

Core's coordinator remains independent of CLI chat defaults. To select it
explicitly on the host:

```sh
bzzy-core assistant set abliteration --model abliterated-model-large-v2 --effort max
```

Shared skills, goal verification, durable history, approved tool permissions and
persistent Agent restrictions use the existing Core execution path. Adding this
provider grants no additional filesystem, network, account or YOLO permissions.

Validation uses synthetic credentials and an isolated HTTP catalog for discovery,
scope/effort validation, backend launch configuration, credential separation,
error sanitization and redirect rejection. Live paid inference requires the
user's own configured key and is not claimed by these fixtures.
