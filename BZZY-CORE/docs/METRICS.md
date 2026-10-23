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
