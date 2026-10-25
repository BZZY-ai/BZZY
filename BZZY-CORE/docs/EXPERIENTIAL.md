# Experiential Labs provider

`experiential` is a built-in Core API-key provider using
`https://api.experientiallabs.ai/v1` and the existing Codex Responses adapter.
The installed Codex CLI is required. Core supplies private per-run configuration;
it does not edit the user's Codex subscription configuration. This follows
[Experiential's Codex integration](https://platform.experientiallabs.ai/docs/coding-agents).

Authenticate through BZZY's hidden terminal prompt:

```sh
bzzy auth experiential
bzzy --provider experiential --model gpt-5.6-sol
```

Alternatively, configure `EXPLABS_API_KEY` in the host environment. Experiential
uses Bearer authentication. Keys remain in private host storage or the selected
backend environment; subscription backends and Core tool environments exclude
this credential. Never put keys in chat, skills, reusable agents, shared projects,
or source control. See [authentication](https://platform.experientiallabs.ai/docs/authentication).

The default model is `gpt-5.6-sol`, the upstream Codex example. Its fallback profile
uses a 1,050,000-token context window, text/image input, and medium reasoning by
default. The fallback effort choices are none, low, medium, high and xhigh: the
intersection of its default provider routes when this integration was added.
Those capabilities apply only to that exact slug. They are not guarantees for
every gateway model or future route configuration.

Core discovers model metadata through authenticated, same-origin
`GET /api/models?limit=50&offset=…` catalog pages. This documented rich catalog
includes public models and the organization's own models, with per-model context,
modalities and deployment capabilities. Inference uses each model's exact `slug`,
never its catalog UUID or an upstream vendor's ID. Explicitly inactive models,
non-text outputs, and models whose listed routes cannot stream or use tools are omitted.
Known effort lists are intersected across the listed default routes; an empty
intersection leaves only provider-default reasoning. Missing metadata does not
invent effort levels. Live metadata takes precedence over the exact-model
fallback. See the [model catalog](https://platform.experientiallabs.ai/docs/models).

Discovery is bounded to 2,000 source entries, 40 pages, 4 MiB per page and 16 MiB
in total, within the existing discovery deadline. Incomplete pages, repeated
entries or changing totals return the existing manual-selection screen instead of a partial catalog.
An unavailable catalog does not establish successful authentication or inference.
Catalog visibility does not guarantee a particular model's access, regional
eligibility, credits or route capabilities; the gateway checks admission on every
request.

Manual IDs remain supported. An unknown model without live metadata gets a local
32,768-token planning budget, text-only input and no implicit reasoning setting.
That budget is an estimate, not a claim about the upstream model's capacity.
An explicit manual effort still needs to be supported by the gateway. The adapter
does not inherit the template ChatGPT model's image or reasoning capabilities.

Experiential documents Responses streaming, function/custom tools, reasoning and
continuations. Some capabilities vary by route; custom-tool grammars translated
to function instructions on non-OpenAI routes are not grammar-enforced. Reasoning
levels can be reduced or refused by upstream policy. Continuations depend on the
organization's capture/retention settings. BZZY does not change those settings,
connect upstream provider accounts, or administer the Experiential organization.
See [OpenAI compatibility](https://platform.experientiallabs.ai/docs/openai-compatibility).

Core's coordinator and the shared consensus/compactor model remain independent
of terminal chat defaults. To explicitly select the Core coordinator:

```sh
bzzy-core assistant set experiential --model gpt-5.6-sol --effort high
```

Skills, specialist subagents, durable sessions, goal verification and execution
permissions use the same Core paths. Adding the provider grants no new tool,
filesystem, network, account or YOLO permissions.

Validation uses synthetic keys and isolated HTTP catalog fixtures for pagination,
metadata, effort selection, launch configuration, credential isolation and
sanitized errors/redirect rejection. The installed Codex parser also accepted the
unknown-model catalog with no reasoning levels in an empty temporary home,
using initialization/model listing only. No live model inference or account
credentials were used; paid tool-call compatibility is not claimed by fixtures.
