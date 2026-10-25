import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertPortableDefinitionText as check } from '../src/engine/definition-portability.js';
import { importSkill } from '../src/engine/skills.js';
import { previewDefinitionExport, exportDefinitionBundle, previewDefinitionImport, importDefinitionBundle, discardDefinitionBundleReview } from '../src/engine/definition-bundle.js';

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
