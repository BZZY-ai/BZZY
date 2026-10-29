# DeepSeek session spending

CLI shows **Chat ≈ $… | Compactor ≈ $… = Total ≈ $…** for Solo using the
official `deepseek` provider, or Delegate when either Brain or Hands uses that
provider. The existing **Balance $…** control remains a separate account-wide
balance. Balance, Chat, Compactor and Total use matching badges in a dedicated
row directly below the CLI navigation, wrapping in narrow terminals. DeepSeek model
names served by OrcaRouter, Experiential Labs or other providers do not qualify.
The cost and balance controls are hidden outside these selections.

Only direct DeepSeek API usage is added. Chat rolls up the terminal's own calls
and explicitly linked workers/reviews and restricted document helpers; this includes the Hands cost when Brain
uses Codex or Claude. Background summary generation is counted separately as
Compactor. Native context-compaction usage belongs to Chat when reported there.
Changing providers preserves amounts already recorded and adds nothing for
another provider's calls. Two sessions sharing a directory never share counters.

**Metrics → DeepSeek spending · whole chat**, `bzzy cost [SESSION]`, and the
owner-only session snapshot read the same lifetime projection. The separate
`bzzy session-memory cost [SESSION]` command inspects compactor details. Reads
start no inference, acquire no input lease and never replay missing requests.
Cost receipts and native-thread cursors stay in Core's private store and are
excluded from portable project imports.

New foreground tracking starts before inference on each fresh native thread.
Normalized cumulative input, cached-input and output deltas create idempotent
receipts with their actual selected/resolved DeepSeek model and pinned prices.
Reasoning tokens are already part of output. Reopening retains native-thread
cursors, so cumulative telemetry cannot charge the whole conversation again.
Each restricted compactor attempt has a separate receipt, including retries.

Pricing is an offline estimate using the official
[rate card](https://api-docs.deepseek.com/quick_start/pricing/) verified on
2026-10-28: Flash and V4 Pro, with their supported aliases. It is labelled with
that verification date rather than presented as an invoice. Input cache misses,
cache hits and output use separate rates. Possible peak/Chinese-holiday and
billing-time boundaries, or missing cache breakdowns, produce a range. Unknown
model versions remain unpriced. The account balance is never subtracted to infer
session spending, since other sessions/applications and account credits affect it.

Existing chats work without starting over. Earlier DeepSeek usage without the
ledger is explicitly partial. On a retained native thread without a baseline,
Core can use the backend's last-request breakdown; it never attributes the entire
old cumulative total to today's model. Missing or interrupted usage and bounded
token reservations do not become zero dollars or exact charges. A live DeepSeek
run is marked pending until its recorded accounting finishes. An unknown total
stays unavailable when there is no measured priced amount to display.

This estimate measures direct API consumption, not hypothetical net savings from
future prompt reduction. It does not enforce a financial limit. Updating does
not replace code in already running processes or automatically resume work;
future work must execute through updated Core code to gain new receipts.
