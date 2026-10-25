# Goal validation state

An achieved goal and its subsequent Validate review are separate outcomes.
The original goal keeps its saved completion state; a linked review can add a
validation badge to that exact goal. It cannot silently reopen, replace or resume
the original work.

The terminal shows **Goal achieved ✓ · Validated ✓** only after Core accepts a
completed, supported review of the original objective and requirements. A failed
or incomplete review does not receive the green validation check.

| Validation state | Meaning |
| --- | --- |
| None | This goal has no linked validation request |
| Pending | Its latest linked review is queued or running |
| Validated | The review passed the host acceptance and freshness gates |
| Not validated | The review explicitly does not support the original goal |
| Inconclusive | Evidence, assessment or required verification remains incomplete |
| Paused / cancelled | The review stopped; this is not proof that the goal is false |
| Stale | The goal, scope, requirements, result or evidence changed after the review |

## Green check gates

Core binds the latest linked review to the source session and goal IDs, original
mission/result revisions and evidence. It checks a durable host acceptance receipt
belonging to the review session and review goal. A completed worker reply, a
majority vote, matching model text or a persuasive consensus paragraph cannot
create this receipt or award the badge.

Independent checks use internal `true`, `false` or `null` per original criterion;
chat displays their natural-language explanations. Any valid rejection stops
normal validation. Only uncertain agents receive one private targeted follow-up,
and unresolved uncertainty remains not validated. Unanimous supported reports
proceed to a separate final evidence reviewer; agreement itself awards no badge.

Structured assessments follow the original acceptance criteria. A nonblocking
limitation in `uncertainties` does not automatically turn supported criteria
into `null` or add a citation requirement the user did not specify. Missing
evidence for a required criterion still stays uncertain, and unresolved
objections still block support. Every caveat remains in the persistent ledger
for explicit final-review disposition; neither the criteria rule nor the UI
grants broader scope or network permissions.

The review must support every original acceptance condition, including requested
severity or impact. A real lower-impact vulnerability does not satisfy a HIGH
severity objective. The declared review protocol, evidence inspection, objection
dispositions, declared artifacts and verification checks remain enforced. Any
unresolved objection or required next verification prevents a green badge.

The consensus model explains the checked outcome. Its output has no authority to
upgrade unsupported, inconclusive, stopped or stale results. A successful model
request is not a successful validation.

## Ordering and freshness

The latest linked review controls the displayed validation result. Late completion
of an older review cannot overwrite a newer review, and an unfinished/deleted
review cannot restore a previous green badge. Results for another goal never
decorate the current goal. Imported historical completion is not local proof.

Reads verify the original source bindings and evidence freshness. Stale or
unavailable proof fails closed. Evidence checks are bounded and cache file
identity/size/nanosecond timestamps to avoid hashing unchanged files on every
frame. They never run commands, contact targets or start models.

Workspace-file captures retain both an immutable saved copy and a binding to the
original file. Keep that source available and unchanged, including after goal
completion. A deleted temporary proof file can block review even when its saved
copy is intact. `/validate` announces startup and displays an explicit recovery
error if evidence preflight fails; restoring the original files or recording
fresh evidence is required before retrying. Failure does not create a review or
change the achieved goal. The terminal preserves this error beside the chat
instead of replaying older replies over it.

These gates establish review provenance, evidence integrity/inspection and
compliance with the declared contract. Semantic vulnerability truth still
requires sound assessment and appropriate controls. A free-text goal's model
judgment remains identifiable through its verification provenance; the badge is
not a universal correctness guarantee. See [orchestration](ORCHESTRATION.md).
