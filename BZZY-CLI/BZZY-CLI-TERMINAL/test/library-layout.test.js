import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { libraryActions, libraryLayout } from '../src/library-layout.js';
import { createTerminalTheme } from '../src/terminal-theme.js';
import { clean, cellWidth } from '../src/terminal-format.js';
import { UI } from '../src/ui.js';
import { libraryToggleRow } from '../src/library-toggle-ui.js';
import { createSession } from '@bzzy/core/engine/store.js';
import { createSkill } from '@bzzy/core/engine/skills.js';
import { saveSubagentDefinition } from '@bzzy/core/engine/subagent-definitions.js';
import { saveWorkflow } from '@bzzy/core/engine/workflows.js';
import { saveGoalTemplate } from '@bzzy/core/engine/goal-templates.js';
import { listRecords } from '@bzzy/core/engine/database.js';

test('button toolbars wrap without overlap, retain generous gaps and skip disabled actions in keyboard order', () => {
  const theme = createTerminalTheme({ isTTY: true }, { TERM: 'xterm-256color', COLORTERM: 'truecolor' });
  const rows = [{ text: 'LIBRARY', tone: 'accent' }, { text: 'Import', action: 'import', buttonGroup: 'transfer', buttonIcon: '↓' },
    { text: 'Export', action: 'export', buttonGroup: 'transfer', buttonIcon: '↑' },
    { text: 'Disabled control', action: 'disabled', buttonGroup: 'other', disabled: true },
    libraryToggleRow({ name: '审查-response-🐝', scope: 'global', enabled: true, toggleAction: 'toggle', viewAction: 'view' }, 30)];
  assert.deepEqual(libraryActions(rows), ['import', 'export', 'toggle', 'view']);
  for (const width of [24, 36, 58, 98]) for (let focus = 0; focus < 4; focus++) {
    const layout = libraryLayout(rows, width, theme, { panel: 'skill', focus });
    assert.ok(layout.lines.every(line => cellWidth(line) <= width));
    assert.ok(layout.hits.every(hit => hit.left >= 1 && hit.right <= width && hit.left <= hit.right));
    assert.ok(!layout.hits.some(hit => hit.action === 'disabled'));
    const imported = layout.hits.find(hit => hit.action === 'import'), exported = layout.hits.find(hit => hit.action === 'export');
    assert.match(clean(layout.lines[imported.row]), /\[ ↓ Import \]/);
    assert.match(clean(layout.lines[exported.row]), /\[ ↑ Export \]/);
    if (imported.row === exported.row) assert.ok(exported.left - imported.right >= 5);
    else assert.ok(exported.row > imported.row);
    assert.ok(layout.hits.some(hit => hit.row === layout.focusRow && hit.action === libraryActions(rows)[focus]));
  }
});

test('all four actual libraries render separated buttons and clicking the gap cannot dispatch an action or disturb drafts', async () => {
  const previous = process.env.BZZY_HOME, directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-library-buttons-')));
  process.env.BZZY_HOME = path.join(directory, 'private');
  const input = new PassThrough(); Object.assign(input, { isTTY: true, setRawMode() {} });
  const output = new PassThrough(); Object.assign(output, { isTTY: true, columns: 90, rows: 38 }); output.resume();
  let ui;
  try {
    const session = createSession({ id: 'codex', backend: 'codex' }, directory, 'offline-model');
    createSkill({ name: 'response-check', description: 'Review supplied response evidence.', instructions: 'Inspect supplied synthetic evidence.' }, { scope: 'global' });
    saveSubagentDefinition({ name: 'response-agent', description: 'Review supplied synthetic responses.', instructions: 'Inspect supplied response evidence.' }, { cwd: directory, scope: 'global' });
    saveWorkflow({ name: 'response-process', instructions: 'Review supplied evidence before reporting.' }, { cwd: directory, scope: 'global' });
    saveGoalTemplate({ objective: 'Review supplied response' });
    ui = new UI({ input, output, error: output }); ui.setSession(session.id); ui.updateSession(session);
    ui.tui.value = 'Unsent user draft'; ui.tui.cursor = 4;
    for (const [command, panel, prefix] of [['/skills', 'skills', '/skills'], ['/agents', 'agents', '/agents'],
      ['/workflow library', 'workflows', '/workflow'], ['/saved-goals', 'goals', '/saved-goals']]) {
      await ui.settingsCommand(command);
      for (const columns of [40, 60, 90, 120]) {
        output.columns = columns; ui.tui.render();
        assert.equal(ui.tui.panel, panel); const dispatched = []; ui.tui.localCommand = value => dispatched.push(value);
        const type = ({ skills: 'skill', agents: 'agent', workflows: 'workflow', goals: 'goal' })[panel] + '-action';
        const imported = ui.tui.hitTargets.find(hit => hit.type === type && /^(bundle-import-type|import)$/.test(hit.action));
        const exported = ui.tui.hitTargets.find(hit => hit.type === type && /^(bundle-export-type|export)$/.test(hit.action));
        assert.ok(imported, panel + ' Import is visible'); assert.ok(exported, panel + ' Export is visible');
        assert.match(clean(ui.tui.lastFrame[imported.row - 1]), /\[ ↓ Import \]/);
        if (imported.row === exported.row) { ui.tui.mouse(0, imported.right + 2, imported.row); assert.deepEqual(dispatched, []); }
        ui.tui.mouse(0, imported.left, imported.row); ui.tui.mouse(0, exported.left, exported.row);
        assert.deepEqual(dispatched, [prefix + ' ' + imported.action, prefix + ' ' + exported.action]);
        assert.equal(ui.tui.value, 'Unsent user draft'); assert.equal(ui.tui.cursor, 4);
        assert.doesNotMatch(ui.tui.lastFrame.map(clean).join('\n'), /Unsent user draft/);
        assert.ok(ui.tui.lastFrame.every(line => cellWidth(line) < columns));
      }
      ui.tui.key('', { name: 'escape' }); assert.equal(ui.tui.panel, 'chat');
    }
    assert.equal(listRecords('execution').length, 0); assert.equal(ui.tui.history.length, 0);
  } finally {
    ui?.close(); if (previous === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
