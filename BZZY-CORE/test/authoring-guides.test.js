import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { authoringGuide, authoringHelp } from '../src/engine/authoring-guides.js';
import { importSkill, inspectSkill, readSkill } from '../src/engine/skills.js';
import { normalizeSubagentDefinition, saveSubagentDefinition, getSubagentDefinition } from '../src/engine/subagent-definitions.js';
import { normalizeWorkflow, saveWorkflow, getWorkflow } from '../src/engine/workflows.js';
import { normalizeGoalTemplate, saveGoalTemplate, listGoalTemplates } from '../src/engine/goal-templates.js';
import { previewLibraryExport, buildLibraryArchive, previewLibraryImport, importLibraryBundle,
  discardDefinitionBundleReview } from '../src/engine/definition-bundle.js';
import { listRecords } from '../src/engine/database.js';

const core = fileURLToPath(new URL('../', import.meta.url));
const security = fs.readFileSync(new URL('../assets/generation-security.txt', import.meta.url), 'utf8').trim();
const kinds = ['skills', 'agents', 'workflows', 'goals'];
let directory, previousHome, project, reviews;
test.beforeEach(() => {
  previousHome = process.env.BZZY_HOME;
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-authoring-guide-')));
  process.env.BZZY_HOME = path.join(directory, 'sender');
  project = path.join(directory, 'project'); fs.mkdirSync(project);
  reviews = [];
});
test.afterEach(() => {
  for (const review of reviews) discardDefinitionBundleReview(review);
  if (previousHome === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previousHome;
  fs.rmSync(directory, { recursive: true, force: true });
});
const remember = value => { reviews.push(value); return value; };
function examples(kind, marker) {
  const body = fs.readFileSync(new URL(`../assets/authoring/${kind}.md`, import.meta.url), 'utf8');
  const expression = new RegExp('<!-- bzzy-example:' + marker + ' -->\\s*```([^\\n]*)\\n([\\s\\S]*?)\\n```', 'g');
  const found = [...body.matchAll(expression)].map(match => ({ language: match[1].trim(), text: match[2] + '\n' }));
  assert.ok(found.length, `${kind} has an unambiguous executable ${marker} example`);
  return found;
}
function noExecutions() {
  for (const kind of ['session', 'execution', 'run', 'assignment', 'round']) assert.equal(listRecords(kind).length, 0, `Saving/importing examples creates no ${kind}`);
}

test('each standalone guide includes its actual examples and the complete mandatory security footer', () => {
  for (const kind of kinds) {
    const markdown = authoringGuide(kind);
    assert.equal(typeof markdown, 'string');
    assert.ok(markdown.includes(fs.readFileSync(new URL(`../assets/authoring/${kind}.md`, import.meta.url), 'utf8').trim()));
    assert.ok(markdown.trimEnd().endsWith(security), `${kind} retains the full mandatory policy`);
    assert.doesNotMatch(markdown, /\x1b\[|\x00/);
    assert.ok(markdown.length > security.length);
  }
  for (const kind of ['', 'skill', 'unknown', '../skills', null, {}]) assert.throws(() => authoringGuide(kind));
  for (const args of [['--help-skills', '--help-agents'], ['--help-goals', '--help-goals'], ['--help-workflows', '--goal', 'must-not-run']]) {
    assert.throws(() => authoringHelp(args), { code: 'AUTHORING_HELP_USAGE' });
  }
  assert.equal(authoringHelp(['--', '--help-skills']), null);
  assert.equal(authoringHelp(['A question mentioning --help-agents as text']), null);
  assert.equal(fs.existsSync(process.env.BZZY_HOME), false, 'Reading authoring reference creates no Core state');
});

test('both real entrypoints print plain guides before loading Core state or execution modules', () => {
  const isolatedHome = path.join(directory, 'home'); fs.mkdirSync(isolatedHome);
  const stateFile = path.join(directory, 'state-is-a-file');
  const secret = 'SYNTHETIC_AUTHORING_HELP_PRIVATE_SENTINEL';
  fs.writeFileSync(stateFile, secret);
  const hook = path.join(directory, 'no-runtime.mjs');
  fs.writeFileSync(hook, `import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, nextResolve) {
  const result = nextResolve(specifier, context);
  if (/\\/BZZY-CORE\\/src\\/(?:engine\\.js|core\\.js|engine\\/(?:runtime|database|providers|store|files|process)\\.js)$/.test(result.url)) throw new Error('AUTHORING_HELP_LOADED_RUNTIME');
  return result;
} });\n`);
  const environment = { HOME: isolatedHome, BZZY_HOME: stateFile, PATH: '',
    DEEPSEEK_API_KEY: secret, BZZY_CODEX_BIN: '/nonexistent/authoring-help-backend', BZZY_CLAUDE_BIN: '/nonexistent/authoring-help-backend' };
  const entries = [path.join(core, 'bin', 'bzzy-core.js'), path.resolve(core, '../BZZY-CLI/BZZY-CLI-TERMINAL/bin/bzzy.js')];
  for (const entry of entries) for (const kind of kinds) {
    for (const extra of [[], ['--json']]) {
      const result = spawnSync(process.execPath, ['--import', hook, entry, `--help-${kind}`, ...extra], {
        env: environment, cwd: project, encoding: 'utf8', timeout: 10000, maxBuffer: 256 * 1024,
      });
      assert.equal(result.status, 0, `${path.basename(entry)} ${kind}: ${result.stderr}`);
      assert.equal(result.stderr, '');
      assert.equal(result.stdout.trimEnd(), authoringGuide(kind).trimEnd());
      assert.doesNotMatch(result.stdout, new RegExp(secret));
    }
    const rejected = spawnSync(process.execPath, ['--import', hook, entry, `--help-${kind}`, '--goal', 'must-not-run'], {
      env: environment, cwd: project, encoding: 'utf8', timeout: 10000,
    });
    assert.notEqual(rejected.status, 0);
    assert.doesNotMatch(rejected.stdout + rejected.stderr, new RegExp(secret + '|AUTHORING_HELP_LOADED_RUNTIME'));
  }
  assert.deepEqual(fs.readdirSync(isolatedHome), []);
  assert.deepEqual(fs.readdirSync(project), []);
  assert.equal(fs.readFileSync(stateFile, 'utf8'), secret);
});

test('actual guide examples install and survive a reviewed four-kind Library ZIP roundtrip without running work', () => {
  const skills = examples('skills', 'skill').map((example, index) => {
    assert.equal(example.language, 'markdown');
    const source = path.join(directory, 'skill-' + index); fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, 'SKILL.md'), example.text);
    const saved = importSkill(source, { scope: 'global' });
    assert.equal(saved.enabled, false);
    assert.equal(readSkill(saved.id, { enabledOnly: false }).text, example.text);
    return saved;
  });
  const agents = examples('agents', 'agent').map(example => {
    assert.equal(example.language, 'json');
    const definition = JSON.parse(example.text), normalized = normalizeSubagentDefinition(definition);
    const saved = saveSubagentDefinition(definition, { scope: 'global' });
    assert.equal(saved.instructions, normalized.instructions);
    return { saved, normalized };
  });
  const workflows = examples('workflows', 'workflow').map(example => {
    assert.equal(example.language, 'json');
    const definition = JSON.parse(example.text), normalized = normalizeWorkflow(definition);
    const saved = saveWorkflow(definition, { scope: 'global' });
    assert.equal(saved.instructions, normalized.instructions);
    if (normalized.schemaVersion === 2) {
      for (const rule of normalized.routing.rules) {
        for (const name of [...rule.skills, ...rule.reportSkills]) assert.ok(skills.some(skill => skill.name === name), `Workflow uses authored skill ${name}`);
        if (rule.specialist) assert.ok(agents.some(agent => agent.saved.name === rule.specialist), `Workflow uses authored specialist ${rule.specialist}`);
      }
    }
    return { saved, normalized };
  });
  const goals = examples('goals', 'goal').map(example => {
    assert.equal(example.language, 'json');
    const definition = JSON.parse(example.text), normalized = normalizeGoalTemplate(definition);
    const saved = saveGoalTemplate(definition);
    assert.equal(saved.objective, normalized.objective);
    return saved;
  });
  noExecutions();
  const review = remember(previewLibraryExport({ cwd: project }));
  assert.deepEqual([review.totals.skills, review.totals.agents, review.totals.workflows, review.totals.goals],
    [skills.length, agents.length, workflows.length, goals.length]);
  const output = path.join(process.env.BZZY_HOME, 'relay', 'shares', randomUUID());
  fs.mkdirSync(output, { recursive: true, mode: 0o700 });
  const archive = path.join(output, 'project.zip');
  buildLibraryArchive(archive, { cwd: project, expectedDigest: review.sourceDigest });
  process.env.BZZY_HOME = path.join(directory, 'recipient');
  const recipient = path.join(directory, 'recipient-project'); fs.mkdirSync(recipient);
  const importedReview = remember(previewLibraryImport(archive, { cwd: recipient }));
  assert.deepEqual(importedReview.conflicts, []);
  const imported = importLibraryBundle(importedReview, { cwd: recipient });
  assert.deepEqual([imported.skills.length, imported.agents.length, imported.workflows.length, imported.goals.length],
    [skills.length, agents.length, workflows.length, goals.length]);
  for (const skill of skills) {
    const restored = inspectSkill(skill.name, { scope: 'global' });
    assert.equal(restored.version, skill.version); assert.equal(restored.enabled, false);
  }
  for (const { saved, normalized } of agents) {
    const restored = getSubagentDefinition(saved.name, { scope: 'global', cwd: recipient });
    assert.equal(restored.enabled, false); assert.equal(restored.instructions, normalized.instructions);
    assert.deepEqual(restored.policy, normalized.policy); assert.deepEqual(restored.limits, normalized.limits);
    assert.equal(restored.provider, undefined); assert.equal(restored.model, undefined);
  }
  for (const { saved, normalized } of workflows) {
    const restored = getWorkflow(saved.name, { scope: 'global', cwd: recipient });
    assert.equal(restored.instructions, normalized.instructions); assert.deepEqual(restored.routing, normalized.routing);
  }
  assert.deepEqual(listGoalTemplates().goals.map(goal => goal.objective).sort(), goals.map(goal => goal.objective).sort());
  assert.ok(listGoalTemplates().goals.every(goal => goal.status === null && goal.sessionId === null));
  noExecutions();
});
