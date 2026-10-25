# Cached Core host metrics

The existing Core daemon samples once per second, including while idle. Its
single timer is unreferenced and stops during daemon shutdown. Reading metrics
returns the same cached sample; polling never starts inference or samples the
operating system again.

Trusted local frontends use `CoreMetricsClient.read()` from `@bzzy/core/metrics`.
The authenticated loopback endpoint is `GET /v1/metrics`; an active scoped
`observe` credential is sufficient. Paired clients use encrypted `host.metrics`
with empty parameters and their existing immutable resource/grant.

```json
{
  "version": 1,
  "sampledAt": "2026-10-22T00:00:00.000Z",
  "intervalMs": 1000.5,
  "host": {
    "cpuPercent": 12.5,
    "memory": {
      "totalBytes": 16000000000,
      "usedBytes": 12000000000,
      "freeBytes": 4000000000,
      "usedPercent": 75
    }
  },
  "core": { "cpuPercent": 0.25, "rssBytes": 95000000 }
}
```

Host CPU uses the aggregate busy/total delta across all logical CPUs. Core CPU
uses the daemon process's user+system CPU delta divided by monotonic elapsed time
and logical CPU count. Both report a fraction of the host's total CPU capacity,
from 0 to 100; the first sample and invalid/reset counters report null. Core CPU
and RSS describe the daemon process; host usage also includes model workers and
other applications. Memory usage is exactly total minus free, without claiming
that operating-system caches are unavailable memory. All byte fields are safe
nonnegative integers; CPU and memory percentages are finite and bounded.

The payload includes no PID, hostname, username, paths, process list, environment
or provider information. Samples are transient and never become chat events.
Clients clear stale data on disconnect and poll only while visible. The CLI
polls every second and iOS every two seconds in the foreground. A failed local
read clears the facade's cached connection, so its next poll rediscovers the
daemon. A facade remains pinned to the private host context where it was created.
If a user service is prepared, discovery waits for that supervisor's listener
and never creates a detached fallback during a restart gap.
An explicit operator stop persists a stop intent: existing views cannot restart
Core through polling. Only an explicit Core start or a newly opened CLI clears
that intent. While quiesced, authenticated metrics reads return `CORE_STOPPED`.
Remote reads have a separate 30-read/minute/device budget. Valid event
acknowledgments have a separate 240/minute/device budget. Ordinary application
requests retain their 60/minute limit; invalid acknowledgment attempts count
against that ordinary limit. Authorization and revocation precede these budgets.

Relay separately bounds the encrypted data plane of active approved PAIR grants,
since it cannot inspect encrypted operations. Grant inspection, routed data and
actual recipient delivery acknowledgments share at most 4,096 RPC/minute per
participant/grant. Invitations, claims, enumeration, foreign/revoked grants and
authentication retain their original limits. Deploying these Relay source
changes is required for sustained live streaming plus metrics.

## Session and goal usage

CLI **Metrics** and `/metrics` read `sessionMetrics(sessionId)` from Core's
`engine/session-metrics.js`. This is a local read-only projection of saved
records, separate from the transient host telemetry above. It remains readable
while Core is stopped, never starts a model or service, and refreshes only while
the panel is visible. Current goal, earlier recorded goals, whole-chat totals and
work explicitly performed outside goals have separate views.

A skill use is a successful main `SKILL.md` load at offset zero from a live model
tool host. Core records one receipt per run, skill identity and immutable version.
Repeating that load, reading later pages or supporting files, discovering skills,
opening previews and replaying history do not add uses. A load establishes that
instructions were supplied to the model; it does not prove every workflow step
or script executed. The rule is shared by all providers through Core's tool host.

The CLI displays these receipts as compact **Skill · name · Loaded** rows in
the conversation. A verified child-worker load also appends the identical receipt
to its root conversation; the receipt ID still counts once in Metrics. Named
specialist calls have one updating chat row per assignment, with explicit
starting/running, needs-context, awaiting-review, reviewed and stop states.
Replay deduplicates receipts and lifecycle transitions. The optional `invocations`
field in a current session response is a bounded read-only state projection;
it contains names/selections and status, excluding task instructions and reports.
It never starts or reconciles model work. Unknown current state is not presented
as successful completion or continuing execution.

Specialist invocations count unique accepted named-agent assignments. Follow-ups
count separately by assignment and round. Delegate and Validate assignments
have their own task/role counts. Parallel/Besties peer skill loads roll up through
their explicit group membership; peer creation is not an assignment invocation.
Reading an
agent definition or putting an invocation draft into chat starts no assignment
and adds no invocation. Sessions in the same directory never share totals unless
they are explicitly linked as workers or reviews.

Library ON/OFF switches control future model skill loads and specialist
admissions. Switching an entry, browsing it or attempting a disabled/invalid
invocation adds no use. Re-enabling makes the same method available again;
successful later loads or new accepted requests retain their normal goal/chat
attribution and deduplication rules.

Ordinary chat remains outside goals even if the session retains an older achieved
goal. Worker and linked Validate usage is attributed to the original parent goal
using stored assignment/review bindings. New skill receipts retain immutable
root attribution so a later goal replacement cannot move older counts. Current
and archived goal status/reason come from Core's existing saved goal records.

Older `skill.loaded` events without exact invocation receipts are reported as
coverage gaps and excluded from exact counts. Imported historical events are
also excluded from local invocation counts. Unknown goal attribution contributes
only to chat totals, with a visible partial-history note. Bounded backfill,
ancestry, invocation and row limits are reported through `coverage`; they never
silently present partial data as complete. Aggregation is cached by private host
and session and advances through indexed, scoped events without reading chat,
skill bodies, private bindings or tool arguments. Rebuilding the cache does not
invoke tools or change counts. Metrics are descriptive, never acceptance evidence
or a permission grant.
