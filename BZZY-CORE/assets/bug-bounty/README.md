# Bug bounty workflow and specialists

This optional portable pack contains 25 BZZY specialist definitions, each with
its complete class criteria, plus the bug bounty methodology and the
`vuln-report-writer` reporting skill. Updates ship these source assets; they do
not silently install definitions, replace an owner's Library, select a workflow,
start models or authorize target access.

The installed workflow is a compact execution adaptation. The full supplied
methodology, its BZZY routing additions and source-audit notes remain in
`reference/bug-bounty-methodology.md`; the workflow does not require loading that
historical/reference text into every worker. Class-specific proof requirements
remain complete inside each specialist.

Each file in `agents/` is a self-contained authoring document with `name` and
`description` frontmatter and a Markdown instruction body. The complete file is
under 200 lines; the instruction body fits Core's existing 16,000-byte limit.
There is no runtime dependency on the original `criteria_per_vuln` directory.
Names end in `-agent`, including `xss-agent`, `idor-agent` and `ssrf-agent`.
Provider, model, effort and permissions are omitted so Core applies its normal
parent selection, permission narrowing and bounded worker execution.

Core's existing owner administration accepts JSON definitions containing
`name`, `description` and `instructions`; when installing these authoring files,
use the frontmatter for the first two fields and the complete body for the third.
Do not submit Markdown frontmatter as permission configuration. No native tools
are granted by the pack. Once installed, use the normal Agents ON/OFF controls
and Library Import/Export to manage or transfer the definitions.

The criteria are instructions, not a new machine proof verifier. Each specialist
must return the G1-G8 and C-criterion assessments with scoped evidence, controls,
limitations and cleanup. Core's existing assignment review and goal acceptance
remain authoritative; a CONFIRMED string or a filled table cannot award a
validation badge. The supervisor preserves the exact admitted criteria as
evidence for later review instead of substituting a newer Library definition.

Import `bug-bounty-methodology.json` as a global workflow named
`bug-bounty-methodology` to install its version 2 structured routing contract.
The JSON contains the complete Markdown text plus 25 explicit class-to-specialist
rules and the confirmation-only reporting skill requirement. Core's local
workflow file import accepts this validated JSON document; portable Library
exports retain the same contract. The `.md` file remains available for authoring
and older text-only integrations; importing only that file creates a legacy
advisory workflow and cannot provide the version 2 completion gate.
Select the installed workflow through `/workflow` before submitting a new
`/goal`; existing goals retain their original pinned workflow. The coordinator
routes bounded hypotheses to matching enabled specialists and reviews their
actual evidence. Independent work may run concurrently within Core's limits;
shared mutable accounts, profiles and objects require isolation or serial work.

The v2 coordinator declares a concrete class hypothesis with `declare_work_unit`,
reads the admitted specialist, passes the returned `workUnitId` when spawning,
and closes the unit after supervisor evidence review. Core requires the exact
specialist version and accepted assignment for investigated outcomes; a generic
Delegate worker cannot satisfy the route. `confirmed` also requires a complete
current-goal read of the pinned `vuln-report-writer` SKILL.md. Disabled or missing
definitions are explicit blockers. This pack permits reasoned `blocked`,
`not_applicable` and `policy_excluded` closures without consultation; these are
coverage dispositions, never proof of a finding. Blocked units do not count as
covered and prevent achievement. An explicit same-class replacement using
`supersedes` admits new pins while retaining the old blocked history. Core
requires at least one declared unit, all units closed and no unresolved blockers
before its routing gate passes. It
does not require all 25 classes or claim to detect every action hidden inside
arbitrary terminal commands. Original goal/evidence acceptance still applies.

After confirmation, supervisor review and two saved reproductions, the workflow
loads the enabled `vuln-report-writer` skill to prepare the report. That is the
skill's exact name. The reporter uses project-relative permitted output paths,
secure local private bindings, the current program's taxonomy and genuine
evidence. Preparing a report never authorizes external submission.

The source methodology retains its supplied source-audit and attribution notes.
It covers web/API research; native, blockchain and availability assessments need
their own environment and scope rules. Program authorization and runtime policy
always constrain every workflow and specialist step.
