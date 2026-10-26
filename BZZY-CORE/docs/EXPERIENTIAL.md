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
uses a 1,050,000-token context window and text/image input. Those capabilities
apply only to that exact slug. They are not guarantees for every gateway model
or future route configuration. Default effort leaves reasoning to the gateway;
Core adds no implicit effort for this provider.

Core discovers model metadata through authenticated, same-origin
`GET /api/models?limit=50&offset=…` catalog pages. This documented rich catalog
includes public models and the organization's own models, with per-model context,
modalities and deployment capabilities. Inference uses each model's exact `slug`,
never its catalog UUID or an upstream vendor's ID. Explicitly inactive models,
non-text outputs, and models whose listed routes cannot stream or use tools are omitted.
Known effort metadata remains intersected across the listed default routes;
live metadata takes precedence over the exact-model fallback. The explicit
effort request controls below are separate from these capability observations.
See the [model catalog](https://platform.experientiallabs.ai/docs/models).

For **Experiential only**, the CLI's **Effort** dropdown and `/effort` always offer
**Default, None, Minimal, Low, Medium, High and Max**. Opening this list requires
no catalog request or API key, and starts no inference. Saved non-reasoning flags,
missing metadata and narrower route lists cannot hide these manual choices.
The same controls apply to model selection and saved defaults, including Core
and the shared Consensus & Compactor model. Other providers retain their existing
model-specific restrictions.

These are **requested effort** levels, not a guarantee that every model implements
them. Core forwards the explicit selection unchanged through the Codex Responses
adapter's reasoning configuration (`reasoning.effort` on the Responses wire).
The gateway may lower, drop or reject the requested effort according to its
route policy, reporting adjustments in `x-experiential-ignored-parameters`.
Default/unset adds no reasoning override. Previously saved `xhigh` values remain
accepted for compatibility but are not offered as new manual choices.
See [request compatibility](https://platform.experientiallabs.ai/llms.txt).

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
The adapter does not inherit the template ChatGPT model's image or reasoning
capabilities. Selecting effort does not verify model access or authentication;
actual execution still requires this host's valid private credentials.

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
metadata, launch configuration, credential isolation and sanitized errors/redirect
rejection. Offline and actual terminal mouse tests cover the manual effort list;
configuration tests cover all six selections despite stale disabled metadata,
unchanged forwarding, Default and legacy values, and other-provider restrictions.
No live model inference or account credentials were used; paid tool-call
compatibility and the gateway's effective effort are not claimed by fixtures.
