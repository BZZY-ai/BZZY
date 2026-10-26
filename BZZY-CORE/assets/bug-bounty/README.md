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

Import `bug-bounty-methodology.md` as a global workflow named
`bug-bounty-methodology`. Select it through `/workflows` before submitting a new
`/goal`; existing goals retain their original pinned workflow. The coordinator
routes bounded hypotheses to matching enabled specialists and reviews their
actual evidence. Independent work may run concurrently within Core's limits;
shared mutable accounts, profiles and objects require isolation or serial work.

After confirmation, supervisor review and two saved reproductions, the workflow
loads the enabled `vuln-report-writer` skill to prepare the report. That is the
skill's exact name. The reporter uses project-relative permitted output paths,
secure local private bindings, the current program's taxonomy and genuine
evidence. Preparing a report never authorizes external submission.

The source methodology retains its supplied source-audit and attribution notes.
It covers web/API research; native, blockchain and availability assessments need
their own environment and scope rules. Program authorization and runtime policy
always constrain every workflow and specialist step.
