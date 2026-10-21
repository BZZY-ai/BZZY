import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { humanActivity, ActivityReporter } from '../src/live-activity.js';
import { createSession } from '../src/store.js';
import { BUILTINS } from '../src/providers.js';
import { RunnerUI } from '../src/runtime-ui.js';
import { events } from '../src/database.js';
import { projectRecords } from '../src/project.js';
import { recordActivity } from '../src/activity.js';

test('footer browsing and extraction produce understandable progress without shell commands or credentials', () => {
  const objective = 'Visit paypal.com and extract the footer';
  for (const [name, input] of [
    ['WebFetch', { url: 'https://paypal.com/?token=private-secret', prompt: 'Extract footer text' }],
    ['commandExecution', { command: "curl -sSL -H 'Authorization: Bearer private-secret' https://paypal.com/ > /tmp/page.html" }],
    ['Bash', { command: "curl https://paypal.com/", description: 'curl -sSL paypal' }],
  ]) {
    const result = humanActivity(name, input, objective);
    assert.equal(result.summary, 'Checking the footer on paypal.com');
    assert.match(result.details, /opening paypal.com.*footer.*text/);
    assert.doesNotMatch(JSON.stringify(result), /curl|Bearer|private-secret|Authorization|\/tmp\/page/);
  }
  const extraction = humanActivity('shell', { command: 'python3 extract_footer.py /tmp/page.html' }, objective);
  assert.equal(extraction.summary, 'Extracting the footer text');
  assert.match(humanActivity('Bash', { command: 'npm test' }).details, /checks/);
  assert.equal(humanActivity('Read', { file_path: '/project/code.js' }).summary, 'Reviewing the relevant files');
  assert.equal(humanActivity('Bash', { description: 'Compare profile ownership controls', command: 'python3 check.py' }).summary, 'Compare profile ownership controls');
});
test('fallback progress is durable, attributed, deduplicated and yields to explicit agent updates', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-human-activity-')), previous = process.env.BZZY_HOME;
  process.env.BZZY_HOME = path.join(directory, 'private');
  try {
    const session = createSession(BUILTINS.codex, directory), ui = new RunnerUI(session.id), reporter = new ActivityReporter(session, ui, 'Visit paypal.com and extract its footer');
    const first = reporter.tool('call-1', 'shell', { command: 'curl https://paypal.com/' });
    assert.equal(first.provenance, 'host-inferred'); assert.equal(first.toolCallId, 'call-1');
    assert.equal(reporter.tool('call-2', 'shell', { command: 'curl https://paypal.com/another' }), undefined);
    const explicit = recordActivity(session, { summary: 'Reading the footer links', details: 'I found the footer section and am extracting its navigation labels.' }, ui);
    reporter.explicit(explicit);
    assert.equal(reporter.tool('call-3', 'shell', { command: 'python3 extract_footer.py' }), undefined);
    const history = events(session.id).filter(event => event.type === 'activity');
    assert.equal(history.length, 2); assert.equal(history[0].data.summary, 'Checking the footer on paypal.com');
    assert.equal(history[1].data.provenance, 'agent-reported');
    assert.equal(projectRecords(directory, 'activities').length, 2); ui.close();
  } finally {
    if (previous == null) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
