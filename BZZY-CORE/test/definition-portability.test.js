import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertPortableDefinitionText as check } from '../src/engine/definition-portability.js';
import { importSkill } from '../src/engine/skills.js';
import { previewDefinitionExport, exportDefinitionBundle, previewDefinitionImport, importDefinitionBundle, discardDefinitionBundleReview } from '../src/engine/definition-bundle.js';
import { previewLibraryExport, buildLibraryArchive, previewLibraryImport, importLibraryBundle } from '../src/engine/definition-bundle.js';
import { saveSubagentDefinition } from '../src/engine/subagent-definitions.js';
import { saveWorkflow } from '../src/engine/workflows.js';
import { saveGoalTemplate } from '../src/engine/goal-templates.js';
import { listRecords } from '../src/engine/database.js';

let directory, previous;
test.beforeEach(() => {
  previous = process.env.BZZY_HOME;
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-portability-')));
  process.env.BZZY_HOME = path.join(directory, 'source-core');
});
test.afterEach(() => {
  if (previous === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous;
  fs.rmSync(directory, { recursive: true, force: true });
});
const runtime = `import os, getpass
def signup(email: str, token: str):
    password = os.environ.get("TEST_PASSWORD")
    if not password:
        password = getpass.getpass("Test password: ")
    token = body.get("idToken", "")
    payload = {"email": email, "password": password}
    headers = {"Authorization": f"Bearer {token}"}
    print(f"Verification email: {email}")
`;
test('ordinary authorization prose and Python runtime references are portable without treating configuration literals as expressions', () => {
  check('Work only from explicit authorization: supplied targets and scope.\nNever report a model claim as verified.');
  check(runtime, { resourcePath: 'scripts/example.py' });
  for (const value of ['password: fixture-private-value', 'password:\n  fixture-private-value', '- token: fixture-private-value',
    'API_KEY=fixture-private-value', 'client.api_key = "fixture-private-value"', 'config["api_key"] = "fixture-private-value"',
    'Use password: "fixture-private-value"',
    "curl -H 'Authorization: Bearer fixture-private-value'", 'Cookie: session=fixture-private-value',
    '{"authorization":{"value":"fixture-private-value"}}']) assert.throws(() => check(value), /literal credential/);
  for (const value of ['password = "fixture-private-value"', 'password = str("fixture-private-value")',
    'headers={"Authorization": f"Bearer fixture-private-value-{token}"}']) {
    assert.throws(() => check(value, { resourcePath: 'scripts/example.py' }), /literal credential/);
  }
  assert.throws(() => check('password: supplied_password', { resourcePath: 'references/setup.yaml' }), /literal credential/);
});
test('account values, private host paths and recognizable keys still block even in explanatory prose and Python strings', () => {
  for (const value of ['Use reader@fixture-account.invalid.', 'Read /Users/fixture-owner/private-case.', 'A sample sk-' + 'q'.repeat(32)]) {
    assert.throws(() => check(value, { resourcePath: 'scripts/example.py' }));
  }
  check('password: <private-binding>\nAPI_KEY=${API_KEY}\n');
});

test('a root receiver distinguishes absolute private paths from relative filenames, longer names and URL paths', t => {
  t.mock.method(os, 'homedir', () => '/root');
  const context = { cwd: '/fixture/project', hostHome: '/fixture/core', privateRoots: ['/fixture/private'] };
  for (const text of ['Read 00-scope/roots.txt.', 'Read 00-scope/root/hosts.txt.', '/roots.txt', '/rooted/data.txt',
    'https://target.invalid/root/login', 'http://[::1]/root/login', 'https://target.invalid/fixture/project/inputs',
    'relative/fixture/project/inputs', '/fixture/project-copy/results', '/fixture/core-other/state', '/fixture/private-notes']) {
    assert.doesNotThrow(() => check(text, context), text);
  }
  for (const text of ['/root', '/root/private/data', 'Read /root.', 'value=/root/private', '"/root/private"',
    'file:///root/private', 'file://localhost/root/private', 'https://target.invalid/?file=/root/private', '`/fixture/project/input.txt`',
    'Read /fixture/core/state.', 'Read /fixture/private/case.txt.']) {
    assert.throws(() => check(text, context), error => error.code === 'DEFINITION_BUNDLE' && error.reasonCode === 'PRIVATE_HOST_PATH', text);
  }
});

test('a Mac-produced four-kind Library imports under a root home with relative root filenames unchanged', t => {
  let receiverHome = '/Users/fixture-sender'; t.mock.method(os, 'homedir', () => receiverHome);
  const source = path.join(directory, 'package'), project = path.join(directory, 'project');
  fs.mkdirSync(path.join(source, 'references'), { recursive: true }); fs.mkdirSync(project);
  const text = 'Use 00-scope/roots.txt and 00-scope/root/hosts.txt as supplied relative inputs.\n';
  fs.writeFileSync(path.join(source, 'SKILL.md'), '---\nname: relative-inputs\ndescription: Review supplied inputs.\n---\n' + text);
  fs.writeFileSync(path.join(source, 'references', 'methodology.md'), text);
  const original = importSkill(source, { scope: 'global' });
  saveSubagentDefinition({ name: 'relative-reviewer', description: 'Review supplied controls.', instructions: text }, { scope: 'global', cwd: project });
  saveWorkflow({ name: 'relative-flow', description: 'Review supplied inputs.', instructions: text }, { scope: 'global', cwd: project });
  saveGoalTemplate({ objective: text });
  const exported = previewLibraryExport({ cwd: project }), share = path.join(process.env.BZZY_HOME, 'relay', 'shares', randomUUID());
  fs.mkdirSync(share, { recursive: true, mode: 0o700 }); let imported;
  try {
    const file = path.join(share, 'project.zip'); buildLibraryArchive(file, { cwd: project, expectedDigest: exported.sourceDigest });
    receiverHome = '/root'; process.env.BZZY_HOME = path.join(directory, 'root-recipient-core');
    imported = previewLibraryImport(file, { cwd: project });
    const result = importLibraryBundle(imported, { cwd: project, enable: true });
    assert.deepEqual(['skills', 'agents', 'workflows', 'goals'].map(kind => result[kind].length), [1, 1, 1, 1]);
    assert.equal(result.skills[0].version, original.version);
    assert.equal(fs.readFileSync(path.join(process.env.BZZY_HOME, 'skills', original.name, original.version, 'references/methodology.md'), 'utf8'), text);
    assert.equal(listRecords('execution').length, 0); assert.equal(listRecords('session').length, 0);
  } finally { discardDefinitionBundleReview(exported); if (imported) discardDefinitionBundleReview(imported); }
});
test('portable Python resources round trip unchanged through sender and recipient checks without executing their code', () => {
  const source = path.join(directory, 'package'), project = path.join(directory, 'project');
  fs.mkdirSync(path.join(source, 'scripts'), { recursive: true }); fs.mkdirSync(project);
  fs.writeFileSync(path.join(source, 'SKILL.md'), '---\nname: runtime-checks\ndescription: Inspect supplied inputs.\n---\nWork only from explicit authorization: supplied targets and scope.\n');
  fs.writeFileSync(path.join(source, 'scripts', 'example.py'), runtime);
  const original = importSkill(source, { scope: 'global' });
  const exported = previewDefinitionExport({ cwd: project });
  let imported;
  try {
    const archive = exportDefinitionBundle(exported, { cwd: project });
    process.env.BZZY_HOME = path.join(directory, 'recipient-core');
    imported = previewDefinitionImport(archive.path, { cwd: project });
    const result = importDefinitionBundle(imported, { cwd: project });
    assert.equal(result.skills[0].version, original.version); assert.equal(result.skills[0].enabled, false);
    assert.equal(fs.readFileSync(path.join(process.env.BZZY_HOME, 'skills', original.name, original.version, 'scripts/example.py'), 'utf8'), runtime);
  } finally { discardDefinitionBundleReview(exported); if (imported) discardDefinitionBundleReview(imported); }
});
