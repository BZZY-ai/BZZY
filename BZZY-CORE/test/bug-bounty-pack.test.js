import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { listRecords } from '../src/engine/database.js';
import { normalizeSubagentDefinition, saveSubagentDefinition, getSubagentDefinition, listSubagentDefinitions } from '../src/engine/subagent-definitions.js';
import { normalizeWorkflow, saveWorkflow, getWorkflow } from '../src/engine/workflows.js';
import { importSkill, inspectSkill, setSkillEnabled, readSkill } from '../src/engine/skills.js';
import { previewLibraryExport, buildLibraryArchive, previewLibraryImport, importLibraryBundle, discardDefinitionBundleReview } from '../src/engine/definition-bundle.js';

const pack = fileURLToPath(new URL('../assets/bug-bounty/', import.meta.url));
const workflowInput = () => JSON.parse(fs.readFileSync(path.join(pack, 'bug-bounty-methodology.json'), 'utf8'));
const definitions = () => fs.readdirSync(path.join(pack, 'agents')).filter(name => !name.startsWith('._') && name.endsWith('.md')).sort().map(file => {
  const markdown = fs.readFileSync(path.join(pack, 'agents', file), 'utf8');
  const match = /^---\nname: ([a-z0-9-]+)\ndescription: ("[^\n]+")\n---\n\n([\s\S]+)$/.exec(markdown);
  assert.ok(match, `Invalid authoring metadata: ${file}`);
  return { markdown, file, input: { name: match[1], description: JSON.parse(match[2]), instructions: match[3].trim() } };
});
let directory, previousHome, reviews;
test.beforeEach(() => {
  previousHome = process.env.BZZY_HOME; directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-bounty-pack-')));
  process.env.BZZY_HOME = path.join(directory, 'source'); reviews = [];
});
test.afterEach(() => {
  for (const review of reviews) discardDefinitionBundleReview(review);
  if (previousHome === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previousHome;
  fs.rmSync(directory, { recursive: true, force: true });
});

test('all 25 self-contained agents fit native schemas and sizes, inherit model selection and route through one valid workflow', () => {
  const agents = definitions(), workflow = normalizeWorkflow(workflowInput());
  assert.equal(agents.length, 25); assert.equal(new Set(agents.map(item => item.input.name)).size, 25);
  for (const { file, markdown, input } of agents) {
    assert.equal(file, input.name + '.md'); assert.ok(markdown.trimEnd().split('\n').length < 200, file);
    assert.ok(Buffer.byteLength(input.instructions) <= 16000, file);
    assert.deepEqual(normalizeSubagentDefinition(input), input);
    assert.match(input.instructions, /## Embedded validation criteria/);
    assert.match(input.instructions, /\*\*C1\*\*/); assert.match(input.instructions, /\*\*G8 Bounded proof/);
    assert.match(input.instructions, /UNKNOWN\/NOT_APPLICABLE/);
    assert.match(input.instructions, /vuln-report-writer/);
    assert.ok(workflow.instructions.includes('`' + input.name + '`'), file);
  }
  assert.match(workflow.instructions, /read_skill/); assert.match(workflow.instructions, /two authorized reproductions/);
  assert.match(workflow.instructions, /exact admitted specialist definition and embedded criteria/);
  assert.match(workflow.instructions, /Submission remains a separate explicitly authorized action/);
  assert.equal(listRecords('execution').length, 0);
});

test('the complete pack round-trips through native Library ZIP validation with full criteria, enabled discovery and no execution', () => {
  const inputs = definitions().map(item => item.input), project = path.join(directory, 'source-project'); fs.mkdirSync(project);
  const originals = inputs.map(input => saveSubagentDefinition({ ...input, capabilities: { version: 1, tags: [input.name.replace(/-agent$/, '')] } }, { scope: 'global' }));
  const workflow = saveWorkflow(workflowInput(), { scope: 'global' });
  const reporter = importSkill(path.join(pack, 'vuln-report-writer'), { scope: 'global' });
  setSkillEnabled(reporter.name, true, reporter.revision, { scope: 'global' });
  const kinds = ['agent', 'workflow', 'skill'], preview = previewLibraryExport({ cwd: project, kinds }); reviews.push(preview);
  assert.equal(preview.entries.length, 27);
  const shareDirectory = path.join(process.env.BZZY_HOME, 'relay', 'shares', randomUUID()); fs.mkdirSync(shareDirectory, { recursive: true, mode: 0o700 });
  const archive = buildLibraryArchive(path.join(shareDirectory, 'project.zip'), { cwd: project, kinds, expectedDigest: preview.sourceDigest });
  process.env.BZZY_HOME = path.join(directory, 'recipient');
  const recipient = path.join(directory, 'recipient-project'); fs.mkdirSync(recipient);
  const review = previewLibraryImport(archive.path, { cwd: recipient }); reviews.push(review);
  const installed = importLibraryBundle(review, { cwd: recipient, enable: true });
  assert.equal(installed.agents.length, 25); assert.equal(installed.skills.length, 1); assert.equal(installed.workflows.length, 1);
  for (const original of originals) {
    const restored = getSubagentDefinition(original.name, { scope: 'global' });
    assert.equal(restored.instructions, original.instructions); assert.equal(restored.version, original.version); assert.equal(restored.enabled, true);
    assert.deepEqual(restored.capabilities, original.capabilities);
  }
  assert.equal(listSubagentDefinitions({ scope: 'global', enabledOnly: true, limit: 100 }).total, 25);
  assert.equal(getWorkflow(workflow.name, { scope: 'global' }).instructions, workflow.instructions);
  assert.deepEqual(getWorkflow(workflow.name, { scope: 'global' }).routing, workflow.routing);
  assert.equal(getWorkflow(workflow.name, { scope: 'global' }).schemaVersion, 2);
  const skill = inspectSkill(reporter.name, { scope: 'global' }); assert.equal(skill.enabled, true); assert.equal(skill.version, reporter.version);
  const skillText = readSkill(reporter.name, { scope: 'global', limit: 32768 }).text;
  assert.match(skillText, /never publish gate passwords, bearer tokens/); assert.doesNotMatch(skillText, /\.\.\/findings|<real JWT>|No placeholders anywhere/);
  assert.match(skillText, /exactly four sections/);
  const retry = previewLibraryImport(archive.path, { cwd: recipient }); reviews.push(retry);
  importLibraryBundle(retry, { cwd: recipient, enable: true });
  assert.equal(listSubagentDefinitions({ scope: 'global', limit: 100 }).total, 25);
  assert.equal(listRecords('execution').length, 0); assert.equal(listRecords('session').length, 0);
});
