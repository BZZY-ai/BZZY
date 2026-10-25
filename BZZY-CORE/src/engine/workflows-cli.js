import path from 'node:path';
import { listWorkflows, getWorkflow, saveWorkflow, importWorkflow, deleteWorkflow, readWorkflowTextFile,
  workflowSelection, selectWorkflow, getGoalWorkflow } from './workflows.js';

const usage = 'Usage: bzzy workflows list [--global] | show NAME [--global] | create FILE.json [--global] | import FILE.txt --name NAME [--description TEXT] [--global] | update FILE.json --revision N [--global] | delete NAME --revision N [--global] | selection --session ID | clear --session ID --revision N | use NAME --session ID --revision N [--workflow-revision N] [--global]';
export function workflowsCLI(args, options = {}, ui) {
  if (!Array.isArray(args) || args.some(value => typeof value !== 'string')) throw new Error(usage);
  const values = [], flags = new Set(), selected = { cwd: path.resolve(options.cwd || process.cwd()) };
  let expectedRevision, expectedWorkflowRevision, sessionId, name, description;
  const number = value => { if (!/^(?:0|[1-9][0-9]{0,14})$/.test(value || '')) throw new Error(usage); return Number(value); };
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (value === '--global') { if (flags.has(value)) throw new Error(usage); flags.add(value); selected.scope = 'global'; }
    else if (['--revision', '--workflow-revision', '--session', '--name', '--description'].includes(value)) {
      if (flags.has(value) || args[index + 1] === undefined) throw new Error(usage);
      flags.add(value); const item = args[++index];
      if (value === '--revision') expectedRevision = number(item);
      if (value === '--workflow-revision') expectedWorkflowRevision = number(item);
      if (value === '--session') sessionId = item;
      if (value === '--name') name = item;
      if (value === '--description') description = item;
    } else if (value.startsWith('-')) throw new Error(usage);
    else values.push(value);
  }
  const [command = 'list', argument, ...rest] = values;
  if (rest.length || !['list', 'show', 'create', 'import', 'update', 'delete', 'selection', 'use', 'clear'].includes(command) ||
      ['list', 'selection', 'clear'].includes(command) && argument !== undefined || !['list', 'selection', 'clear'].includes(command) && !argument ||
      ['update', 'delete', 'use', 'clear'].includes(command) && expectedRevision === undefined ||
      ['update', 'delete'].includes(command) && expectedRevision < 1 ||
      ['list', 'show', 'create', 'import', 'selection'].includes(command) && expectedRevision !== undefined ||
      ['selection', 'use', 'clear'].includes(command) !== Boolean(sessionId) || command !== 'import' && (name !== undefined || description !== undefined) ||
      command === 'import' && !name || command !== 'use' && expectedWorkflowRevision !== undefined) throw new Error(usage);
  let result;
  if (command === 'list') {
    const workflows = []; let offset = 0;
    do { const page = listWorkflows({ ...selected, offset, limit: 100 }); workflows.push(...page.workflows); offset = page.nextOffset; } while (offset !== null);
    result = { workflows, total: workflows.length, nextOffset: null };
  } else if (command === 'show') result = getWorkflow(argument, selected);
  else if (command === 'import') result = importWorkflow(argument, { ...selected, name, description });
  else if (command === 'delete') result = deleteWorkflow(argument, { ...selected, expectedRevision });
  else if (command === 'selection') result = { ...workflowSelection(sessionId), goal: getGoalWorkflow(sessionId) };
  else if (['use', 'clear'].includes(command)) result = selectWorkflow(sessionId, command === 'clear' ? null : argument,
    { ...selected, expectedRevision, expectedWorkflowRevision });
  else {
    let input;
    try { input = JSON.parse(readWorkflowTextFile(argument, selected)); } catch { throw new Error('Workflow definitions must be bounded UTF-8 JSON with name, description and instructions.'); }
    result = saveWorkflow(input, { ...selected, expectedRevision: expectedRevision || 0 });
  }
  if (ui?.event) ui.event('info', { result, message: JSON.stringify(result, null, 2) });
  else process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  return 0;
}
