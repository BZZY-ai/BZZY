import fs from 'node:fs';
import path from 'node:path';
import { home, loadSession } from '@bzzy/core/engine/store.js';
import { shareLibraryBundle, importTerminal, forgetPrivateImportInput, enterShareCode } from './share-ui.js';
import { wrap } from './terminal-format.js';

const codePattern = /^BZZY-LIBRARY-[A-Za-z0-9_-]{43}$/;
const automaticCodePattern = /^BZZY-LIBRARY-2(?:\.[A-Za-z0-9_-]{43}){4}$/;
const fingerprint = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
const defaultShareKinds = ['skill', 'agent', 'workflow', 'goal'];
const names = { skill: 'Skill', agent: 'Specialist agent', workflow: 'Workflow', goal: 'Goal', extension: 'Extension' };
const shareTypes = { skill: 'Skills', agent: 'Agents', workflow: 'Workflows', goal: 'Goals', extension: 'Extensions' };
const typeAliases = { skill: 'skill', skills: 'skill', agent: 'agent', agents: 'agent', workflow: 'workflow', workflows: 'workflow', goal: 'goal', goals: 'goal', extension: 'extension', extensions: 'extension' };
function shareKinds(values) {
  if (!Array.isArray(values) || !values.length || values.some(value => !Object.hasOwn(shareTypes, value))) throw new Error('Choose at least one of skills, agents, workflows or goals.');
  return [...new Set(values)].sort();
}
const count = value => Array.isArray(value) ? value.length : Number.isSafeInteger(value) && value >= 0 ? value : 0;
const summary = totals => ['skills', 'agents', 'workflows', 'goals', ...(totals?.extensions ? ['extensions'] : [])].map(kind => `${count(totals?.[kind])} ${kind}`).join(' · ');
const safeImportErrors = {
  LEGACY_LIBRARY_CODE: 'This is an older code. Update the sender and create a new export code.',
  WRONG_LIBRARY_KIND: 'This code contains no entries for the selected tab.',
  INVITE_EXPIRED: 'The Library code expired. Ask the sender for a new one.',
  INVITE_UNAVAILABLE: 'The Library code was already used or is unavailable. Ask the sender for a new one.',
  HOST_MISMATCH: 'The sender does not match the fingerprint you confirmed.',
  UNTRUSTED_PEER: 'The sender identity could not be verified.',
  WRONG_PURPOSE: 'Use a Library code for this import.',
  FORBIDDEN: 'The source authorization changed. Nothing further can be imported.',
  PEER_OFFLINE: 'The sender must remain online until the transfer finishes.',
  HOST_OFFLINE: 'The sender must remain online until the transfer finishes.',
  STALE_REVIEW: 'The Library or destination changed. Review the import again.',
  CONFLICT: 'The Library or destination changed. Review the import again.',
  SECRET_DETECTED: 'The Library failed its private-data checks. Nothing was installed.',
  SHARE_SECRET_DETECTED: 'The Library failed its private-data checks. Nothing was installed.',
  DEFINITION_BUNDLE: 'The Library failed its package or integrity checks. Nothing was installed.',
  UNCERTAIN: 'Library transfer status is uncertain. Inspect the destination Library before retrying.',
};
const importReasons = {
  CREDENTIAL: 'A configured credential or recognizable secret pattern was detected.',
  CREDENTIAL_LITERAL: 'A literal credential or account binding is embedded.',
  PRIVATE_ACCOUNT: 'An account address is embedded.',
  PRIVATE_HOST_PATH: 'An absolute private host path is embedded.',
};
function importDiagnostic(error) {
  const value = error?.importDiagnostic;
  if (!['DEFINITION_BUNDLE', 'SHARE_SECRET_DETECTED', 'SECRET_DETECTED'].includes(error?.code)
    || !value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Object.keys(value).some(key => !['kind', 'name', 'scope', 'reasonCode', 'file', 'line'].includes(key))
    || !Object.hasOwn(names, value.kind) || !['global', 'project'].includes(value.scope)
    || typeof value.name !== 'string' || value.name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.name)
    || !Object.hasOwn(importReasons, value.reasonCode)) return null;
  if (value.file !== undefined && (typeof value.file !== 'string' || value.file.length > 240 || !/^[a-zA-Z0-9_./-]+$/.test(value.file)
    || value.file.startsWith('/') || value.file.split('/').some(part => !part || part.startsWith('.') || part === '..'))) return null;
  if (value.line !== undefined && (!value.file || !Number.isSafeInteger(value.line) || value.line < 1 || value.line > 1000000)) return null;
  return Object.fromEntries(['kind', 'name', 'scope', 'reasonCode', 'file', 'line'].filter(key => value[key] !== undefined).map(key => [key, value[key]]));
}
function importDiagnosticMessage(error) {
  const value = importDiagnostic(error);
  return value ? `Library import blocked: ${names[value.kind]} · ${value.name} · ${value.scope}${value.file ? ` · ${value.file}${value.line ? ':' + value.line : ''}` : ''}. ${importReasons[value.reasonCode]} Nothing was installed.` : null;
}
const localErrors = new Set(['The host or terminal changed. Reopen Library transfer.', 'The terminal project changed. Reopen Library transfer.',
  'Update BZZY Core and CLI together to select Library entries.',
  'Use a BZZY-LIBRARY code from the sender’s Library share screen.', 'Compare and enter the complete sender fingerprint before importing.']);

function terminal(ui) {
  if (!ui.interactive || ui.json || ui.input?.isTTY === false || ui.output?.isTTY === false) {
    throw new Error('Library sharing requires a private interactive terminal. Codes cannot be printed in JSON or redirected output.');
  }
  ui.openTerminal?.();
}
function context(ui, cwd) {
  const root = fs.realpathSync(cwd), stat = fs.lstatSync(root);
  return { home: home(), root, device: stat.dev, inode: stat.ino, session: ui.sessionId, tab: ui.activeTab, next: ui.nextSession?.id };
}
function check(ui, before) {
  if (ui.closed || ui.coreLifecycleInterrupted || home() !== before.home || ui.sessionId !== before.session
    || ui.activeTab !== before.tab || ui.nextSession?.id !== before.next) throw new Error('The host or terminal changed. Reopen Library transfer.');
  const stat = fs.lstatSync(before.root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== before.device || stat.ino !== before.inode
    || before.session && loadSession(before.session)?.cwd !== before.root) throw new Error('The terminal project changed. Reopen Library transfer.');
}
async function checked(ui, before, operation) { check(ui, before); const result = await operation(); check(ui, before); return result; }

function tabKind(kind) {
  if (!Object.hasOwn(shareTypes, kind)) throw new Error('Choose Skills, Agents, Workflows or Goals.');
  return kind;
}
const entryKey = entry => JSON.stringify([entry.kind, entry.scope || 'global', entry.name]);
const pinFields = ['kind', 'scope', 'name', 'id', 'revision', 'version'];
const entryPin = entry => Object.fromEntries(pinFields.map(field => [field, entry[field]]));
const samePin = (left, right) => JSON.stringify(entryPin(left)) === JSON.stringify(entryPin(right));
const changedSelection = () => Object.assign(new Error('The selected Library entries changed. Reopen Export.'), { code: 'STALE_REVIEW' });
async function selectNames(ui, before, operation, kind, entries, labels = {}) {
  const label = entry => {
    const name = labels[entryKey(entry)] || entry.name;
    return kind ? name : `${names[entry.kind]} · ${name}${entry.kind === 'goal' ? '' : ` (${entry.scope === 'global' ? 'Core' : 'project'})`}`;
  };
  const counts = new Map();
  for (const { entry } of entries) counts.set(label(entry), (counts.get(label(entry)) || 0) + 1);
  const choices = entries.map(({ entry, index }) => ({ value: String(index),
    label: label(entry) + (counts.get(label(entry)) > 1 ? ` (${entry.kind === 'goal' ? entry.name.slice(-8) : entry.scope === 'global' ? 'Core' : 'project'})` : ''), selected: true }));
  const selected = await checked(ui, before, () => ui.chooseMany(`${operation} ${kind ? shareTypes[kind].toLowerCase() : 'Library'}`, choices, {
    scope: `library-${operation.toLowerCase()}`, columnHeader: kind ? 'NAME' : 'TYPE · NAME', confirmLabel: operation, cancelLabel: 'Back',
    emptyMessage: 'Select at least one name.', hint: `Space toggles · Enter ${operation.toLowerCase()}s · Esc back`,
    description: operation === 'Import' ? 'Import enables the selected entries for use.' : kind ? 'Only checked names will be shared.'
      : 'All skills, agents, workflows and saved goals start selected. Uncheck any names to leave them out.',
  }));
  if (!selected?.length) return null;
  const allowed = new Map(choices.map(choice => [choice.value, Number(choice.value)]));
  if (!Array.isArray(selected) || new Set(selected).size !== selected.length || selected.some(value => !allowed.has(value))) throw new Error('The selection changed. Reopen Import or Export.');
  return selected.map(value => allowed.get(value));
}

export async function transferLibraryTab(operation, kind, cwd, ui, options = {}) {
  tabKind(kind);
  return transferLibrarySelection(operation, kind, cwd, ui, options);
}

export function transferLibrary(operation, cwd, ui, options = {}) {
  return transferLibrarySelection(operation, undefined, cwd, ui, options);
}

export function libraryTransferErrorMessage(error) {
  const diagnostic = importDiagnosticMessage(error); if (diagnostic) return diagnostic;
  if (safeImportErrors[error?.code]) return safeImportErrors[error.code];
  if (localErrors.has(error?.message) || Object.values(safeImportErrors).includes(error?.message)) return error.message;
  if (['LIBRARY_BLOCKED_ENTRIES', 'LIBRARY_BLOCKED_GOALS'].includes(error?.code)) return 'Some selected entries contain private or nonportable data. Review them with /library share, or uncheck them before exporting.';
  return 'Library transfer failed. Check Core/Relay and the selected packages, then try again.';
}

async function transferLibrarySelection(operation, kind, cwd, ui, { loadBundle = () => import('@bzzy/core/engine/definition-bundle.js'), ...options } = {}) {
  if (operation === 'import') return importLibrary('', cwd, ui, { ...options, loadBundle, selectionKind: kind, currentCodesOnly: true });
  if (operation !== 'export') throw new Error('Choose Import or Export.');
  const kinds = kind ? [kind] : [...defaultShareKinds].sort();
  terminal(ui); const before = context(ui, cwd), backend = await checked(ui, before, loadBundle);
  if (typeof backend.listLibraryExportChoices !== 'function' || typeof backend.previewSelectedLibraryExport !== 'function') throw new Error('Update BZZY Core and CLI together to select Library entries.');
  const catalog = await checked(ui, before, () => backend.listLibraryExportChoices({ cwd: before.root, kinds }));
  if (!Array.isArray(catalog.entries) || catalog.entries.some(entry => !kinds.includes(entry.kind))) throw new Error('The Library list changed. Reopen Export.');
  if (!catalog.entries.length) {
    const message = kind ? `No ${shareTypes[kind].toLowerCase()} to export.` : 'No Library entries to export.';
    ui.event('info', { message }); options.onComplete?.(null, message); return null;
  }
  const indexes = await selectNames(ui, before, 'Export', kind, catalog.entries.map((entry, index) => ({ entry, index })), catalog.labels);
  if (!indexes) return null;
  const originalSelection = indexes.map(index => catalog.entries[index]);
  let selectedEntries = [...originalSelection];
  let review;
  try {
    while (!review) {
      const current = await checked(ui, before, () => backend.listLibraryExportChoices({ cwd: before.root, kinds }));
      const available = new Map((current.entries || []).map(entry => [entryKey(entry), entry]));
      if (originalSelection.some(entry => !available.has(entryKey(entry)) || !samePin(entry, available.get(entryKey(entry))))) throw changedSelection();
      if (!selectedEntries.length) {
        const message = 'No portable entries remain to export.';
        ui.event('info', { message }); options.onComplete?.(null, message); return null;
      }
      try { review = await checked(ui, before, () => backend.previewSelectedLibraryExport({ cwd: before.root, kinds, selectedEntries })); }
      catch (error) {
        const omitted = await omitBlockedEntries(ui, before, error, selectedEntries);
        if (!omitted) return null;
        const definitions = new Set(omitted.entries.map(entryKey)), goals = new Set(omitted.goalIds);
        selectedEntries = selectedEntries.filter(entry => entry.kind === 'goal' ? !goals.has(entry.id) : !definitions.has(entryKey(entry)));
      }
    }
    if (!Array.isArray(review.kinds) || JSON.stringify([...review.kinds].sort()) !== JSON.stringify(kinds) ||
      JSON.stringify(review.entries.map(entryKey).sort()) !== JSON.stringify(selectedEntries.map(entryKey).sort())) throw new Error('The selected Library entries changed. Reopen Export.');
    return await shareLibraryBundle(before.root, review, ui, { ...options, compact: true, assertContext: () => check(ui, before) });
  } finally { if (review) backend.discardDefinitionBundleReview(review); }
}

function automaticImports(backend, review, kind) {
  const matches = review.entries.map((entry, index) => ({ entry, index })).filter(row => !kind || row.entry.kind === kind);
  if (!matches.length) throw Object.assign(new Error('This code contains no entries for this tab.'), { code: 'WRONG_LIBRARY_KIND' });
  return { approved: true, enable: true, entryIndexes: backend.libraryImportEntryIndexes(matches.map(row => row.index), review.entries.length) };
}

const blockedDetails = entry => `${entry.file || 'Package'}${entry.line ? ':' + entry.line : ''}\n${entry.reason}`;
async function inspectBlockedEntry(ui, before, entry) {
  let page = 0;
  while (true) {
    const lines = wrap(blockedDetails(entry), Math.max(1, (ui.output?.columns || 80) - 14));
    page = Math.min(page, lines.length - 1);
    const action = await checked(ui, before, () => ui.chooseOne(`Blocked · ${entry.name} · ${page + 1}/${lines.length}`, {
      description: lines[page], descriptionRows: 1,
      choices: [{ value: 'back', label: '← Back to blocked entries', selected: true },
        ...(page + 1 < lines.length ? [{ value: 'next', label: 'Read next diagnostic line' }] : []),
        ...(page ? [{ value: 'previous', label: 'Read previous diagnostic line' }] : [])],
    }));
    if (!action || action === 'back') return;
    if (action === 'next' && page + 1 < lines.length) page++;
    else if (action === 'previous' && page) page--;
  }
}

async function omitBlockedEntries(ui, before, error, selectedEntries) {
  if (error?.code === 'LIBRARY_BLOCKED_ENTRIES' && Array.isArray(error.blockedEntries) && error.blockedEntries.length) {
    const blocked = error.blockedEntries, seen = new Set();
    for (const entry of blocked) {
      const key = entryKey(entry), selected = selectedEntries?.find(item => entryKey(item) === key);
      if (!['skill', 'agent', 'workflow', 'extension'].includes(entry.kind) || seen.has(key)
        || selectedEntries && (!selected || !samePin(entry, selected))) throw changedSelection();
      seen.add(key);
    }
    while (true) {
      const action = await checked(ui, before, () => ui.chooseOne('Some selected entries cannot be shared', {
        description: `${blocked.length} blocked entries. Select an entry to read its complete safe diagnostic.`,
        choices: [{ value: 'back', label: '← Back without sharing', selected: true },
          { value: 'omit', label: `Omit these ${blocked.length} blocked entries and ${selectedEntries ? 'export' : 'review'} the rest` },
          ...blocked.map((entry, index) => ({ value: `blocked:${index}`, label: `${names[entry.kind]} · ${entry.name} · ${entry.scope}`,
            description: blockedDetails(entry) }))],
      }));
      const index = /^blocked:(\d+)$/.exec(action);
      if (index && blocked[Number(index[1])]) { await inspectBlockedEntry(ui, before, blocked[Number(index[1])]); continue; }
      return action === 'omit' ? { entries: blocked.map(entryPin), goalIds: [] } : null;
    }
  }
  if (error?.code !== 'LIBRARY_BLOCKED_GOALS' || !Array.isArray(error.blockedGoals) || !error.blockedGoals.length) throw error;
  const blocked = error.blockedGoals, seen = new Set();
  for (const entry of blocked) {
    if (typeof entry.id !== 'string' || seen.has(entry.id)
      || selectedEntries && !selectedEntries.some(item => item.kind === 'goal' && item.id === entry.id)) throw changedSelection();
    seen.add(entry.id);
  }
  const action = await checked(ui, before, () => ui.chooseOne('Some saved goals cannot be shared', {
    description: `${blocked.length} goals contain private or nonportable data. They cannot enter this Library bundle.\n${blocked.map(item => `${String(item.id).slice(0, 18)}… · ${item.reason}`).join('\n')}`,
    descriptionRows: 10,
    choices: [{ value: 'back', label: '← Back without sharing', selected: true },
      { value: 'omit', label: `Omit these ${blocked.length} blocked goals and ${selectedEntries ? 'export' : 'review'} the remaining Library` }],
  }));
  return action === 'omit' ? { entries: [], goalIds: blocked.map(item => item.id) } : null;
}

async function inspectEntry(ui, before, backend, review, index) {
  const entry = review.entries[index];
  let fileIndex = 0, offset = 0, screenStart = 0;
  while (true) {
    const file = entry.files[fileIndex];
    const page = await checked(ui, before, () => backend.readDefinitionBundleFile(review, {
      cwd: before.root, entryIndex: index, file: file.path, offset, limit: 16384,
    }));
    const lines = wrap(page.text == null ? 'Binary resource; its exact bytes are preserved.' : page.text, Math.max(12, (ui.output?.columns || 80) - 14));
    const screenRows = Math.max(1, Math.min(6, (ui.output?.rows || 24) - 18));
    screenStart = Math.min(screenStart, Math.max(0, lines.length - 1));
    const choice = await checked(ui, before, () => ui.chooseOne(`${names[entry.kind] || entry.kind} · ${entry.name}`, {
      description: `${file.path}\nSHA256 ${page.sha256}\nLines ${screenStart + 1}–${Math.min(lines.length, screenStart + screenRows)} / ${lines.length}\n${lines.slice(screenStart, screenStart + screenRows).join('\n')}`,
      descriptionRows: 16,
      choices: [{ value: 'back', label: '← Back to Library review', selected: true },
        ...(screenStart + screenRows < lines.length ? [{ value: 'next-screen', label: 'Read next lines' }]
          : page.nextOffset != null ? [{ value: 'next-page', label: 'Read next text page' }] : []),
        ...(screenStart ? [{ value: 'previous-screen', label: 'Read previous lines' }] : []),
        ...(offset ? [{ value: 'start', label: 'Read from the beginning' }] : []),
        ...entry.files.map((resource, index) => ({ value: `file:${index}`, label: resource.path }))],
    }));
    if (!choice || choice === 'back') return;
    if (choice === 'next-screen' && screenStart + screenRows < lines.length) screenStart += screenRows;
    else if (choice === 'previous-screen') screenStart = Math.max(0, screenStart - screenRows);
    else if (choice === 'next-page' && page.nextOffset != null) { offset = page.nextOffset; screenStart = 0; }
    else if (choice === 'start') { offset = 0; screenStart = 0; }
    else if (/^file:\d+$/.test(choice) && entry.files[Number(choice.slice(5))]) { fileIndex = Number(choice.slice(5)); offset = 0; screenStart = 0; }
  }
}

export async function reviewLibrary(ui, before, backend, review, { importing = false } = {}) {
  while (true) {
    const conflicts = review.conflicts || [];
    const existing = new Set(conflicts.map(entry => JSON.stringify([entry.kind, entry.scope || 'global', entry.name])));
    const missing = review.entries.length - conflicts.length;
    const choice = await checked(ui, before, () => ui.chooseOne(importing ? 'Install missing Library entries' : 'Share BZZY Library', {
      description: `${summary(review.totals)}\n${importing ? `${missing} missing entries · ${conflicts.length} entries already exist and will be skipped. Existing names and availability stay unchanged.` : `Selected types: ${(review.kinds || [...defaultShareKinds]).map(kind => shareTypes[kind]).join(', ')}.${review.excludedEntries?.length ? ` ${review.excludedEntries.length} blocked entries explicitly omitted.` : ''}${review.excludedGoals?.length ? ` ${review.excludedGoals.length} blocked goals explicitly omitted.` : ''} Review the exact files below.`}\nProject definitions use this terminal’s directory. No credentials, chat history, permissions or verified outcomes are included.`,
      descriptionRows: 7,
      choices: [{ value: 'back', label: '← Back without changes', selected: true },
        ...(importing ? [{ value: 'enable', label: 'Install missing & enable reviewed skills/agents', description: 'No scripts, agents or models start. Workflows stay unselected; goals remain saved text.' },
          { value: 'install', label: 'Install missing entries disabled' }]
          : [{ value: 'share', label: 'Create expiring Relay code for this Library' }]),
        ...review.entries.map((entry, index) => ({ value: `entry:${index}`,
          label: `${importing ? existing.has(JSON.stringify([entry.kind, entry.scope || 'global', entry.name])) ? 'Already here · skip | ' : 'New | ' : ''}${names[entry.kind] || entry.kind} · ${entry.name} · ${entry.scope || 'global'}`,
          description: entry.description || 'Inspect exact package files before continuing.' })),
      ],
    }));
    if (!choice || choice === 'back') return null;
    if (!importing && choice === 'share') return true;
    if (importing && ['enable', 'install'].includes(choice)) return { approved: true, enable: choice === 'enable' };
    const index = /^entry:(\d+)$/.exec(choice);
    if (index && review.entries[Number(index[1])]) await inspectEntry(ui, before, backend, review, Number(index[1]));
  }
}

export async function shareLibrary(cwd, ui, { loadBundle = () => import('@bzzy/core/engine/definition-bundle.js'), kinds, ...options } = {}) {
  terminal(ui); const before = context(ui, cwd);
  if (kinds === undefined) {
    kinds = await checked(ui, before, () => ui.chooseMany('What do you want to share?', defaultShareKinds.map(value => [value, shareTypes[value]]).map(([value, label]) => ({ value, label, selected: true })),
      { scope: 'library-types', hint: 'Space toggles · ↑/↓ moves · Enter reviews · Esc goes back', description: 'Only the selected Library types enter the review and expiring Relay code.' }));
    if (!kinds?.length) return null;
  }
  const selectedKinds = shareKinds(kinds), backend = await checked(ui, before, loadBundle);
  let review, excludeGoalIds = [], excludeEntries = [];
  while (!review) {
    try { review = await checked(ui, before, () => backend.previewLibraryExport({ cwd: before.root, kinds: selectedKinds, excludeEntries, excludeGoalIds })); }
    catch (error) {
      const omitted = await omitBlockedEntries(ui, before, error);
      if (!omitted) return null;
      excludeEntries = [...new Map([...excludeEntries, ...omitted.entries].map(entry => [JSON.stringify(entry), entry])).values()];
      excludeGoalIds = [...new Set([...excludeGoalIds, ...omitted.goalIds])];
    }
  }
  try {
    if (!Array.isArray(review.kinds) || JSON.stringify([...review.kinds].sort()) !== JSON.stringify(selectedKinds)) throw new Error('Update BZZY Core and CLI together to share selected Library types.');
    if (!await reviewLibrary(ui, before, backend, review)) return null;
    check(ui, before);
    return await shareLibraryBundle(before.root, review, ui, { ...options, assertContext: () => check(ui, before) });
  } finally { backend.discardDefinitionBundleReview(review); }
}

export async function importLibrary(value, cwd, ui, { relayLoader = () => import('@bzzy/core/relay'), loadBundle = () => import('@bzzy/core/engine/definition-bundle.js'), selectionKind, currentCodesOnly = false, onComplete } = {}) {
  if (selectionKind !== undefined) tabKind(selectionKind);
  terminal(ui); const before = context(ui, cwd), previous = ui.privateView;
  const view = { title: 'ENTER CODE', lines: [], qr: [], onCancel: null };
  let code = String(value || '').trim();
  let goalLabels = new Map();
  ui.privateView = view; ui.tui?.schedule();
  try {
    if (!code) code = (await checked(ui, before, () => ui.secret('ENTER CODE · Enter continues · Esc back')))?.trim() || '';
    if (!code) return null;
    const automatic = automaticCodePattern.test(code);
    if (!automatic && !codePattern.test(code) && !code.startsWith('BZZY:INVITE:1:')) throw new Error('Use a BZZY-LIBRARY code from the sender’s Library share screen.');
    if ((selectionKind || currentCodesOnly) && !automatic) throw Object.assign(new Error('Create a new export code.'), { code: 'LEGACY_LIBRARY_CODE' });
    let sender;
    if (!automatic) {
      view.title = 'VERIFY SENDER'; view.lines = ['On the sender, open Verification to compare its fingerprint.']; ui.tui?.schedule();
      sender = (await checked(ui, before, () => ui.ask('Sender fingerprint · Enter continues · Esc back')))?.trim();
      if (!sender) return null;
      if (!fingerprint(sender)) throw new Error('Compare and enter the complete sender fingerprint before importing.');
    }
    const abort = new AbortController(); view.onCancel = () => abort.abort();
    view.title = 'IMPORT'; view.lines = []; view.progress = { label: 'Connecting to Relay…' }; ui.tui?.schedule();
    const backend = await checked(ui, before, loadBundle), relay = await checked(ui, before, relayLoader);
    if ((selectionKind || automatic) && typeof backend.libraryImportEntryIndexes !== 'function') throw new Error('Update BZZY Core and CLI together to select Library entries.');
    const result = await relay.importLibraryShare({ code, cwd: before.root, ...(sender ? { expectedSenderFingerprint: sender } : {}), signal: abort.signal,
      onIdentity({ recipientFingerprint }) {
        check(ui, before);
        if (!fingerprint(recipientFingerprint)) { abort.abort(); return; }
        view.progress = { label: automatic ? 'Authorizing secure transfer…' : 'Waiting for sender approval…' };
        view.lines = automatic ? [] : [`Recipient fingerprint: ${recipientFingerprint}`, 'Compare on the sender and choose Approve recipient.']; ui.tui?.schedule();
      },
      onPhase(phase) {
        const labels = { connecting: 'Connecting to Relay…', downloading: 'Downloading encrypted Library…', checking: 'Checking package integrity…', installing: 'Installing new entries…' };
        if (!abort.signal.aborted && ui.privateView === view && labels[phase]) { view.lines = []; view.progress = { label: labels[phase] }; ui.tui?.render?.(); ui.tui?.schedule(); }
      },
      onProgress({ received, total }) {
        if (!abort.signal.aborted && ui.privateView === view && Number.isSafeInteger(received) && Number.isSafeInteger(total) && received >= 0 && total >= received) {
          view.lines = []; view.progress = { label: 'Downloading encrypted Library…', received, total }; ui.tui?.schedule();
        }
      },
      onReview: async review => {
        if (automatic) {
          check(ui, before);
          const decision = automaticImports(backend, review, selectionKind);
          goalLabels = new Map(review.entries.filter(entry => entry.kind === 'goal').map(entry => [entry.version, entry.description || entry.name]));
          return decision;
        }
        // A private transport screen has no composer reader. Release it while
        // the ordinary selection dialog owns keyboard/mouse input.
        if (ui.privateView === view) ui.privateView = previous;
        ui.tui?.schedule();
        try {
          const decision = await checked(ui, before, () => reviewLibrary(ui, before, backend, review, { importing: true }));
          view.lines = []; view.progress = { label: decision?.approved ? 'Installing selected entries…' : 'Cancelling import…' };
          return decision;
        }
        finally { if (ui.privateView === previous) ui.privateView = view; ui.tui?.schedule(); }
      },
    });
    check(ui, before);
    let message;
    if (automatic) {
      const installed = result.alreadyImported ? [] : ['skill', 'agent', 'workflow', 'goal', 'extension'].flatMap(kind => (result[kind + 's'] || []).map(entry => ({ kind, name: kind === 'goal' ? goalLabels.get(entry.version) || entry.name || entry.id : entry.name || entry.id })));
      message = installed.length ? 'Installed:\n' + [...new Set(installed.map(entry => `${names[entry.kind]} · ${entry.name}`))].join('\n') : 'Already installed. Nothing new was added.';
    } else message = `${result.alreadyImported ? 'Library already installed' : 'Library installed'}: ${summary(result)}.${result.skipped?.length ? ` Skipped ${result.skipped.length} existing entries.` : ''} No execution started.`;
    ui.event('info', { message }); onComplete?.(result, message);
    return result;
  } catch (error) {
    if (error?.name === 'AbortError' || error?.code === 'CANCELLED') { ui.tui?.notice('Library import cancelled.'); return null; }
    if (error?.code === 'RELAY_UPGRADE_REQUIRED') throw new Error('Update BZZY Relay to support Library codes, then create a new code.');
    if (localErrors.has(error?.message)) throw error;
    const diagnostic = importDiagnostic(error);
    if (diagnostic) throw Object.assign(new Error(importDiagnosticMessage(error)), { code: 'DEFINITION_BUNDLE', importDiagnostic: diagnostic });
    throw new Error(safeImportErrors[error?.code] || 'Library transfer failed. Check Core/Relay, fingerprints and the reviewed package.');
  } finally { code = ''; view.lines = []; view.qr = []; view.progress = null; view.onCancel = null; if (ui.privateView === view) ui.privateView = previous; ui.tui?.schedule(); }
}

export async function importRelayShare(value, cwd, ui, options = {}) {
  terminal(ui); let code = String(value || '').trim();
  try {
    if (!code) code = (await enterShareCode(ui))?.trim() || '';
    if (!code) return null;
    let library = /^BZZY-LIBRARY-/.test(code);
    if (code.startsWith('BZZY:INVITE:1:')) {
      const relay = await (options.relayLoader || (() => import('@bzzy/core/relay')))();
      library = relay.classifyProjectShareCode(code) === 'LIBRARY';
    }
    return library ? await importLibrary(code, cwd, ui, options) : await importTerminal(code, cwd, ui, options);
  } finally { code = ''; }
}

export async function libraryCommand(argument, cwd, ui, options = {}) {
  terminal(ui); const before = context(ui, cwd);
  let action = String(argument || '').trim();
  if (!action) action = await checked(ui, before, () => ui.chooseOne('BZZY Library transfer', {
    description: 'Share skills, specialist agents, workflows and saved goals between BZZY hosts through Relay. Full chats/projects use /share.',
    choices: [{ value: 'back', label: '← Back to chat', selected: true }, { value: 'share', label: 'Share Library · create a code' }, { value: 'import', label: 'Install missing entries · enter a code' }],
  }));
  check(ui, before);
  if (!action || action === 'back') return;
  if (/^share(?:\s|$)/.test(action)) {
    const requested = action.slice(5).trim();
    if (!requested) return shareLibrary(cwd, ui, options);
    const values = requested.toLowerCase().split(/[\s,]+/).map(value => typeAliases[value]);
    return shareLibrary(cwd, ui, { ...options, kinds: shareKinds(values) });
  }
  if (/^import(?:\s|$)/.test(action)) {
    const input = '/library ' + action; forgetPrivateImportInput(ui, input);
    return importLibrary(action.slice(6).trim(), cwd, ui, options);
  }
  throw new Error('Use /library, /library share or /library import.');
}
