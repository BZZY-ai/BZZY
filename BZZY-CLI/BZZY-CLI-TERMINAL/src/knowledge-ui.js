import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { CoreKnowledge } from '@bzzy/core/knowledge';

const context = ui => ui.sessionId ? { sessionId: ui.sessionId } : { cwd: ui.tui?.cwd || process.cwd() };
const key = ui => JSON.stringify(context(ui));
const api = ui => ui.knowledgeAPI ||= new CoreKnowledge();
const request = (ui, operation, fields = {}, scoped = true) => api(ui).request(operation, { ...(scoped ? context(ui) : {}), ...fields });
const action = (text, value) => ({ text, action: 'knowledge:' + value });
const muted = text => ({ text, tone: 'muted' });
const short = value => String(value || '').slice(0, 12);
const encode = encodeURIComponent;
const decode = decodeURIComponent;
const finished = state => ['completed', 'cancelled', 'failed', 'budget_limited'].includes(state);
const list = (value, field) => Array.isArray(value) ? value : value?.[field] || [];
function show(ui, view, data) { ui.knowledgeView = view; ui.knowledgeState = data; ui.knowledgeContextKey = key(ui); }
function invalidate(ui) {
  if (!ui.tui) return;
  ui.tui.bodyCache = null; ui.tui.scroll = 0; ui.tui.skillFocus = 0; ui.tui.skillTopRequested = true; ui.tui.schedule();
}
function errorMessage(error) {
  return ['ENOENT', 'EACCES', 'EPERM', 'ELOOP', 'ENOTDIR'].includes(error.code)
    ? 'This knowledge source is unavailable. Check its location and permissions.' : error.message;
}
async function prompt(ui, method, ...arguments_) {
  const original = key(ui), answer = await ui[method](...arguments_);
  if (key(ui) !== original) throw new Error('Conversation changed. Reopen knowledge for this project before acting.');
  return answer;
}
async function confirm(ui, title, label = 'Confirm') {
  return await prompt(ui, 'chooseOne', title, [{ value: 'cancel', label: 'Cancel', selected: true }, { value: 'yes', label }]) === 'yes';
}
function search(ui) {
  const page = request(ui, 'search', { query: ui.knowledgeQuery || '', offset: ui.knowledgeOffset || 0, limit: 12, includeStale: Boolean(ui.knowledgeIncludeStale) });
  ui.knowledgeHits = page.items; show(ui, 'memory', page);
}
function profiles(ui) { show(ui, 'profiles', request(ui, 'profiles', {}, false)); }
function proposals(ui) { show(ui, 'proposals', request(ui, 'profile.proposals', { offset: ui.knowledgeProposalOffset || 0, limit: 20 }, false)); }
function candidates(ui) { show(ui, 'candidates', request(ui, 'candidates', { offset: ui.knowledgeCandidateOffset || 0, limit: 20 })); }
function fixtures(ui) { show(ui, 'fixtures', request(ui, 'fixtures.list')); }
function memoryHistory(ui, record, offset = 0) { show(ui, 'memory-history', { ...request(ui, 'memory.history', { id: record.id || record.sourceId, offset, limit: 5 }), id: record.id || record.sourceId, headRevision: record.headRevision || record.revision || 1, offset }); }
function profileHistory(ui, record, offset = 0) { show(ui, 'profile-history', { ...request(ui, 'profile.history', { target: record.target, offset, limit: 5 }, false), target: record.target, headRevision: record.headRevision || record.revision, offset }); }
function fixture(ui, id, offset = 0) { show(ui, 'fixture', { ...request(ui, 'fixtures.inspect', { id, includeCases: true }), offset }); }
function job(ui, id) { show(ui, 'job', request(ui, 'learning.inspect', { id })); }
function candidate(ui, id) { show(ui, 'candidate', request(ui, 'candidate.inspect', { id })); }
function overview(ui) { show(ui, 'overview', request(ui, 'status')); }
function refresh(ui) {
  const state = ui.knowledgeState;
  if (ui.knowledgeView === 'memory') search(ui);
  else if (ui.knowledgeView === 'jobs') show(ui, 'jobs', request(ui, 'learning.list', { limit: 30 }));
  else if (ui.knowledgeView === 'job') job(ui, state.id);
  else if (ui.knowledgeView === 'candidates') candidates(ui);
  else if (ui.knowledgeView === 'candidate') candidate(ui, state.id);
  else if (ui.knowledgeView === 'profiles') profiles(ui);
  else if (ui.knowledgeView === 'proposals') proposals(ui);
  else if (ui.knowledgeView === 'fixtures') fixtures(ui);
  else if (ui.knowledgeView === 'fixture') fixture(ui, state.id, state.offset);
  else overview(ui);
}

export function knowledgeRows(ui) {
  if (ui.knowledgeContextKey !== key(ui)) return [muted('Conversation changed. Load knowledge for this project.'), action('Project memory', 'memory'), action('Learning overview', 'home'), action('Back to Skills', 'library')];
  const view = ui.knowledgeView, data = ui.knowledgeState || {}, rows = [];
  if (view === 'overview' || view === 'settings') {
    const settings = data.settings || {}, usage = data.usage || {};
    rows.push({ text: 'Project memory & learning', tone: 'accent' },
      muted(`Learning ${settings.enabled ? 'on' : 'paused'} · ${settings.tokenBudget || 0} tokens/review · ${settings.runtimeSeconds || 0}s`),
      muted(`Today ${usage.tokensUsed || 0} used · ${usage.reservedTokens || 0} reserved · ${usage.remainingTokens || 0} available`));
    if (view === 'settings') rows.push(action(settings.enabled ? 'Pause learning' : 'Enable learning', 'toggle-learning'), action('Edit review and daily budgets', 'edit-budgets'));
    else rows.push(action('Search project memory and history', 'memory'), action('Review this conversation now', 'review'), action('Learning jobs', 'jobs'),
      action('Skill candidates', 'candidates'), action('User and computer profiles', 'profiles'), action('Profile proposals', 'proposals'),
      action('Approved offline fixtures', 'fixtures'), action('Learning controls and budgets', 'settings'));
  } else if (view === 'memory') {
    rows.push({ text: 'Project memory & history', tone: 'accent' }, action(`Search${ui.knowledgeQuery ? ': ' + ui.knowledgeQuery : '…'}`, 'search'),
      action(ui.knowledgeIncludeStale ? 'Hide stale knowledge' : 'Include stale knowledge', 'stale'));
    for (const [index, item] of (data.items || []).entries()) {
      rows.push(action(`${item.kind} · ${item.truth}${item.stale ? ' · STALE' : ''}`, 'hit:' + index), { text: item.statement },
        muted(`Source ${item.sourceId} · ${item.evidence?.length || 0} evidence references`));
    }
    if (!data.items?.length) rows.push(muted('No matching knowledge in this engagement.'));
    if (data.indexing?.remaining) rows.push(muted('More saved history remains to index. Refresh to continue.'));
    if (ui.knowledgeOffset) rows.push(action('Previous results', 'memory-previous'));
    if (data.nextOffset != null) rows.push(action('More results', 'memory-next'));
  } else if (view === 'hit') {
    rows.push({ text: `${data.kind} · ${data.truth}${data.stale ? ' · STALE' : ''}`, tone: 'accent' }, { text: data.statement },
      ...(data.rationale ? [{ text: data.rationale }] : []), ...(data.details ? [{ text: data.details }] : []),
      muted(`Source ${data.sourceId} · Session ${data.sessionId || 'project record'} · Revision ${data.revision || 1}`),
      muted(`Evidence: ${(data.evidence || []).join(', ') || 'none'}`));
    if (data.staleReasons?.length) rows.push(muted('Recheck: ' + data.staleReasons.join(', ')));
    if (data.verification) rows.push(muted('Verification: ' + data.verification.source));
    if (data.whyMatched) rows.push(muted('Matched: ' + (typeof data.whyMatched === 'string' ? data.whyMatched : JSON.stringify(data.whyMatched))));
    if (data.kind === 'memory') rows.push(action('Review this knowledge decision', 'review-memory'), action('Mark stale with a reason', 'invalidate-memory'), action('Version history and restoration', 'memory-history'));
    rows.push(action('Back to search results', 'memory'));
  } else if (view === 'memory-history' || view === 'profile-history') {
    const memory = view === 'memory-history';
    rows.push({ text: `${memory ? 'Knowledge' : data.target + ' profile'} · version history`, tone: 'accent' });
    for (const item of data.items || []) {
      rows.push(muted(`Revision ${item.revision}${memory ? ' · ' + item.truth : ''}${item.stale ? ' · STALE' : ''}`), { text: memory ? item.statement : item.text || '(empty)' });
      if (item.rationale) rows.push({ text: item.rationale });
      if (item.revision !== data.headRevision) rows.push(action(memory ? 'Restore as inconclusive for revalidation' : 'Restore this reviewed profile text', (memory ? 'restore-memory:' : 'restore-profile:') + item.revision));
    }
    if (!data.items?.length) rows.push(muted('No retained revisions.'));
    if (data.offset) rows.push(action('Previous revisions', memory ? 'memory-history-previous' : 'profile-history-previous'));
    if (data.nextOffset != null) rows.push(action('More revisions', memory ? 'memory-history-next' : 'profile-history-next'));
    rows.push(action(memory ? 'Back to project search' : 'Back to profiles', memory ? 'memory' : 'profiles'));
  } else if (view === 'jobs') {
    rows.push({ text: 'Learning jobs · this project', tone: 'accent' }, action('Review this conversation now', 'review'));
    for (const item of list(data, 'jobs')) rows.push(action(`${item.state} · ${item.reason} · ${short(item.id)}`, 'job:' + encode(item.id)), muted(`${item.tokensUsed || 0} tokens · ${item.reasonPaused || ''}`));
    if (!list(data, 'jobs').length) rows.push(muted('No learning jobs in this conversation’s project.'));
  } else if (view === 'job') {
    rows.push({ text: `Learning ${data.state}`, tone: 'accent' }, muted(`Job ${data.id} · revision ${data.revision}`),
      muted(`Reason ${data.reason} · ${data.tokensUsed || 0} tokens used`));
    if (data.reasonPaused) rows.push(muted('Paused: ' + data.reasonPaused));
    if (data.failure) rows.push(muted('Review stopped. Inspect its saved status before retrying.'));
    if (data.result) {
      const publications = data.result.skillPublications || [], ids = [...new Set([...(data.result.skillIds || []), ...publications.map(item => item.skillId).filter(Boolean)])];
      rows.push(muted(`Result: ${(data.result.lessonIds || []).length} lessons · ${ids.length} learned skills · ${(data.result.candidateIds || []).length} skill candidates · ${(data.result.profileProposalIds || []).length} profile proposals${data.result.noChange ? ' · no change needed' : ''}`));
      for (const id of ids) {
        const item = publications.find(entry => entry.skillId === id);
        if (item?.state === 'deleted') rows.push(muted(`${item.name || id} · deleted from Library`));
        else rows.push(action(`Open ${item?.name || id} in Skills Library${item?.scope ? ' · ' + item.scope : ''}`, 'skill:' + encode(id)));
      }
    }
    if (!finished(data.state)) rows.push(...(data.state === 'paused' ? [action('Resume this learning job', 'resume-job')] : [action('Pause this learning job', 'pause-job')]), action('Cancel this learning job', 'cancel-job'));
    rows.push(action('Back to learning jobs', 'jobs'));
  } else if (view === 'candidates') {
    rows.push({ text: 'Reviewable skill candidates', tone: 'accent' });
    for (const item of list(data, 'candidates')) rows.push(action(`${item.name} · ${item.scope} · ${item.state}`, 'candidate:' + encode(item.id)), muted(item.description));
    if (!list(data, 'candidates').length) rows.push(muted('No skill candidates for this project.'));
    if (ui.knowledgeCandidateOffset) rows.push(action('Previous candidates', 'candidates-previous'));
    if (data.nextOffset != null) rows.push(action('More candidates', 'candidates-next'));
  } else if (view === 'candidate') {
    rows.push({ text: `${data.name} · ${data.scope} · ${data.state}`, tone: 'accent' }, { text: data.description }, muted(`Version ${short(data.version)} · revision ${data.revision} · active base ${data.baseRevision}`),
      action('Read proposed instructions and resources', 'candidate-read'));
    if (data.evaluation) rows.push(muted(`Evaluation ${data.evaluation.status} · ${data.evaluation.authority} · fixtures ${short(data.evaluation.fixtureHash)}`), action('Read the recorded fixture results', 'evaluation'));
    else rows.push(muted('No offline fixture evaluation attached.'));
    if (['pending', 'evaluated'].includes(data.state)) {
      rows.push(action('Evaluate on approved offline cases', 'candidate-evaluate'));
      if (data.evaluation?.status === 'passed' && data.evaluation.authority === 'host-fixture') rows.push(action('Review, accept and enable this version', 'candidate-accept'));
      rows.push(action('Reject this candidate', 'candidate-reject'));
    }
    rows.push(action('Back to candidates', 'candidates'));
  } else if (view === 'evaluation') {
    rows.push({ text: `Offline fixture evaluation · ${data.status}`, tone: 'accent' }, muted(`Candidate ${short(data.candidateVersion)} · corpus ${short(data.fixtureHash)} revision ${data.fixtureRevision}`), muted(data.evaluatorVersion));
    for (const item of data.cases || []) rows.push({ text: `${item.passed ? 'PASS' : 'FAIL'} ${item.id} · expected ${item.expected} · actual ${item.actual}` });
    if (data.metrics) rows.push(muted(`Approved baseline ${data.metrics.baselineAvailable ? 'compared' : 'unavailable'} · measured improvement ${data.metrics.improvementDemonstrated ? 'yes' : 'not demonstrated'}`));
    rows.push(action('Read the approved fixture corpus', 'fixture:' + encode(data.fixtureId)), action('Back to candidate', 'candidate:' + encode(data.candidateId)));
  } else if (view === 'candidate-read') {
    rows.push({ text: `${data.name}/${data.file} · ${short(data.version)}`, tone: 'accent' }, { text: data.text }, action('Choose supporting file', 'candidate-files'));
    if (data.nextOffset != null) rows.push(action('Read next page', 'candidate-read-next'));
    rows.push(action('Back to candidate review', 'candidate:' + encode(data.candidateId)));
  } else if (view === 'profiles') {
    rows.push({ text: 'Shared preferences and computer facts', tone: 'accent' });
    for (const profile of data.profiles || []) rows.push({ text: `${profile.target === 'user' ? 'Your preferences' : 'This computer'} · revision ${profile.revision}${profile.stale ? ' · STALE' : ''}` },
      { text: profile.text || '(empty)' }, ...(profile.expiresAt ? [muted('Expires: ' + profile.expiresAt)] : []), action('Edit ' + profile.target + ' profile', 'edit-profile:' + profile.target), action('Version history and restoration', 'profile-history:' + profile.target));
    rows.push(action('Review profile proposals', 'proposals'));
  } else if (view === 'profile-edit') {
    rows.push({ text: `Review ${data.target} profile`, tone: 'accent' }, { text: data.text || '(clear profile)' }, muted(`Replacing revision ${data.expectedRevision}`), action('Save this reviewed profile', 'save-profile'), action('Cancel profile edit', 'profiles'));
  } else if (view === 'proposals') {
    rows.push({ text: 'Profile proposals · owner review', tone: 'accent' });
    for (const item of data.items || []) rows.push(action(`${item.target} · ${item.state} · ${short(item.id)}`, 'proposal:' + encode(item.id)), { text: item.text });
    if (!data.items?.length) rows.push(muted('No profile proposals.'));
    if (ui.knowledgeProposalOffset) rows.push(action('Previous proposals', 'proposals-previous'));
    if (data.nextOffset != null) rows.push(action('More proposals', 'proposals-next'));
  } else if (view === 'proposal') {
    rows.push({ text: `${data.target} profile proposal · ${data.state}`, tone: 'accent' }, { text: data.text }, { text: data.reason }, muted(`User-message source ${data.sourceId} · revision ${data.revision}`));
    if (data.state === 'pending') rows.push(action('Accept this profile change', 'accept-proposal'), action('Reject this profile change', 'reject-proposal'));
    rows.push(action('Back to profile proposals', 'proposals'));
  } else if (view === 'fixtures') {
    rows.push({ text: 'Approved offline fixture sets', tone: 'accent' }, action('Import fixture JSON for review', 'import-fixtures'));
    for (const item of list(data, 'fixtures')) rows.push(action(`${item.name} · ${item.scope || (item.projectId ? 'project' : 'global')} · ${item.caseCount || 0} cases · revision ${item.revision}${item.revokedAt ? ' · REVOKED' : ''}`, 'fixture:' + encode(item.id)));
    if (!list(data, 'fixtures').length) rows.push(muted('No approved cases. Register synthetic or authorized offline cases before evaluating candidates.'));
  } else if (view === 'fixture') {
    const text = JSON.stringify(data.cases, null, 2), offset = data.offset || 0;
    rows.push({ text: `${data.name} · revision ${data.revision}${data.revokedAt ? ' · REVOKED' : ''}`, tone: 'accent' }, muted(`Approved corpus ${short(data.hash)} · ${data.cases?.length || 0} offline cases`), { text: text.slice(offset, offset + 12000) });
    if (offset) rows.push(action('Previous case page', 'fixture-read-previous'));
    if (offset + 12000 < text.length) rows.push(action('More cases', 'fixture-read-next'));
    if (data.reviewed && !data.revokedAt) rows.push(action('Revoke this fixture approval', 'revoke-fixtures'));
    rows.push(action('Back to fixtures', 'fixtures'));
  } else if (view === 'fixture-import') {
    const preview = JSON.stringify(data.definition, null, 2), offset = data.offset || 0;
    rows.push({ text: `Review offline fixtures · ${data.scope}`, tone: 'accent' }, { text: preview.slice(offset, offset + 12000) });
    if (offset) rows.push(action('Previous fixture page', 'fixture-previous'));
    if (offset + 12000 < preview.length) rows.push(action('Next fixture page', 'fixture-next'));
    rows.push(action('Approve and register these exact cases', 'register-fixtures'), action('Cancel fixture import', 'fixtures'));
  }
  if (!['profile-edit', 'fixture-import'].includes(view)) rows.push(action('Refresh', 'refresh'));
  rows.push(action('Learning overview', 'home'), action('Back to Skills', 'library'));
  return rows;
}

function readFixtureJSON(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 128 * 1024) throw new Error('unsafe');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(fd)));
  } catch { throw new Error('Choose a valid UTF-8 fixture JSON file under 128 KiB, without links.'); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

export async function knowledgeAction(command, ui) {
  const split = command.indexOf(':'), verb = split < 0 ? command : command.slice(0, split), argument = split < 0 ? '' : decode(command.slice(split + 1));
  const shown = ui.knowledgeState || {};
  const navigation = new Set(['home', 'memory', 'search', 'jobs', 'candidates', 'profiles', 'proposals', 'fixtures', 'settings', 'library', 'refresh']);
  if (ui.knowledgeContextKey && ui.knowledgeContextKey !== key(ui) && !navigation.has(verb)) throw new Error('Conversation changed. Reopen knowledge for this project before acting.');
  if (verb === 'library') { ui.knowledgeView = null; ui.skillPreview = null; return; }
  if (verb === 'home') overview(ui);
  else if (verb === 'memory') search(ui);
  else if (verb === 'search') { const query = await prompt(ui, 'ask', 'Search this project’s findings, notes and past conversations'); if (query != null) { ui.knowledgeQuery = query.trim(); ui.knowledgeOffset = 0; search(ui); } }
  else if (verb === 'stale') { ui.knowledgeIncludeStale = !ui.knowledgeIncludeStale; ui.knowledgeOffset = 0; search(ui); }
  else if (verb === 'memory-next' || verb === 'memory-previous') { ui.knowledgeOffset = Math.max(0, (ui.knowledgeOffset || 0) + (verb.endsWith('next') ? 12 : -12)); search(ui); }
  else if (verb === 'hit') { const item = ui.knowledgeHits?.[Number(argument)]; if (!item) throw new Error('Refresh project search before opening this record.'); show(ui, 'hit', item); }
  else if (verb === 'review-memory') {
    const truth = await prompt(ui, 'chooseOne', 'Review the recorded claim and its current evidence', ['confirmed', 'disproved', 'inconclusive'].map(value => ({ value, label: value })));
    if (!truth) return;
    const rationale = (await prompt(ui, 'ask', 'Reason for your evidence-based knowledge decision'))?.trim(); if (!rationale) return;
    request(ui, 'memory.review', { id: shown.sourceId, truth, rationale, expectedRevision: shown.revision || 1, reviewed: true }); search(ui);
  } else if (verb === 'invalidate-memory') {
    const reason = (await prompt(ui, 'ask', 'What changed or needs revalidation?'))?.trim(); if (!reason) return;
    request(ui, 'memory.invalidate', { id: shown.sourceId, reason, expectedRevision: shown.revision || 1 }); search(ui);
  } else if (verb === 'memory-history') memoryHistory(ui, shown);
  else if (verb === 'memory-history-next' || verb === 'memory-history-previous') memoryHistory(ui, shown, Math.max(0, shown.offset + (verb.endsWith('next') ? 5 : -5)));
  else if (verb === 'restore-memory') {
    if (!await confirm(ui, `Restore revision ${argument} as inconclusive? Its evidence must be revalidated.`, 'Restore for revalidation')) return;
    request(ui, 'memory.rollback', { id: shown.id, fromRevision: Number(argument), expectedRevision: shown.headRevision, reviewed: true }); search(ui);
  } else if (verb === 'review') {
    const queued = request(ui, 'learning.queue', { requestId: randomUUID() }); job(ui, queued.id);
    ui.event('info', { message: 'Learning review queued. It uses recorded context and a bounded budget.' });
  } else if (verb === 'jobs') show(ui, 'jobs', request(ui, 'learning.list', { limit: 30 }));
  else if (verb === 'job') job(ui, argument);
  else if (verb === 'skill') {
    const publications = shown.result?.skillPublications || [], item = publications.find(entry => entry.skillId === argument);
    if (!(shown.result?.skillIds || []).includes(argument) && !item) throw new Error('Choose a learned skill from this learning job.');
    if (item?.state === 'deleted') throw new Error('This learned skill was deleted from the Library. Its learning history remains available.');
    const original = key(ui), { showSkillInLibrary } = await import('./skills-ui.js');
    if (key(ui) !== original) throw new Error('Conversation changed. Reopen learning for this project before acting.');
    showSkillInLibrary(ui, argument, { scope: item?.scope === 'global' ? 'global' : 'current' });
  }
  else if (['pause-job', 'resume-job', 'cancel-job'].includes(verb)) {
    request(ui, 'learning.control', { id: shown.id, action: verb.split('-')[0], expectedRevision: shown.revision }); job(ui, shown.id);
  } else if (verb === 'settings') show(ui, 'settings', request(ui, 'status'));
  else if (verb === 'toggle-learning') {
    if (!await confirm(ui, shown.settings.enabled ? 'Pause learning and its queued work?' : 'Enable bounded learning? Previously paused jobs still need explicit resume.')) return;
    request(ui, 'learning.settings', { settings: { enabled: !shown.settings.enabled }, expectedRevision: shown.settings.revision, reviewed: true }, false); overview(ui);
  } else if (verb === 'edit-budgets') {
    const settings = {};
    for (const [field, label] of [['tokenBudget', 'Tokens per review'], ['runtimeSeconds', 'Seconds per review'], ['dailyTokenBudget', 'Daily token budget'], ['maxPendingPerProject', 'Maximum queued reviews per project']]) {
      const value = await prompt(ui, 'ask', `${label} · current ${shown.settings[field]} · empty keeps it`); if (value == null) return;
      if (value.trim()) { if (!/^\d+$/.test(value.trim())) throw new Error('Use whole positive numbers for learning budgets.'); settings[field] = Number(value); }
    }
    if (Object.keys(settings).length && await confirm(ui, 'Save learning limits: ' + JSON.stringify(settings))) request(ui, 'learning.settings', { settings, expectedRevision: shown.settings.revision, reviewed: true }, false);
    overview(ui);
  } else if (verb === 'candidates') candidates(ui);
  else if (verb === 'candidates-next' || verb === 'candidates-previous') { ui.knowledgeCandidateOffset = Math.max(0, (ui.knowledgeCandidateOffset || 0) + (verb.endsWith('next') ? 20 : -20)); candidates(ui); }
  else if (verb === 'candidate') candidate(ui, argument);
  else if (verb === 'evaluation') show(ui, 'evaluation', request(ui, 'evaluation.inspect', { id: shown.evaluation.id }));
  else if (verb === 'candidate-read' || verb === 'candidate-read-next') {
    const id = shown.candidateId || shown.id;
    show(ui, 'candidate-read', request(ui, 'candidate.read', { id, file: verb === 'candidate-read' ? 'SKILL.md' : shown.file, offset: verb === 'candidate-read' ? 0 : shown.nextOffset, limit: 16000 }));
  } else if (verb === 'candidate-files') {
    const file = await prompt(ui, 'chooseOne', 'Proposed skill resources', shown.files.map(file => ({ value: file.path, label: `${file.path} · ${file.bytes} bytes` })));
    if (file) show(ui, 'candidate-read', request(ui, 'candidate.read', { id: shown.candidateId, file, offset: 0, limit: 16000 }));
  } else if (verb === 'candidate-evaluate') {
    const available = list(request(ui, 'fixtures.list'), 'fixtures').filter(item => item.reviewed && !item.revokedAt && (!item.projectId || item.projectId === shown.projectId));
    if (!available.length) { fixtures(ui); ui.event('info', { message: 'Register and approve an offline fixture set before evaluating this candidate.' }); return; }
    const datasetId = await prompt(ui, 'chooseOne', 'Approved offline fixture corpus · evaluation consumes its bounded budget', available.map(item => ({ value: item.id, label: `${item.name} · ${item.caseCount} cases · revision ${item.revision}` })));
    if (datasetId) { const queued = request(ui, 'candidate.evaluate', { id: shown.id, datasetId, expectedRevision: shown.revision, requestId: randomUUID() }); job(ui, queued.id); }
  } else if (verb === 'candidate-accept') {
    if (!await confirm(ui, `Enable ${shown.name} ${short(shown.version)} in ${shown.scope}? Evaluation ${short(shown.evaluation?.fixtureHash)}.`, 'Accept and enable')) return;
    request(ui, 'candidate.accept', { id: shown.id, expectedRevision: shown.revision, expectedSkillRevision: shown.baseRevision,
      expectedEvaluationId: shown.evaluation?.id, reviewed: true, activate: true }); candidate(ui, shown.id);
  } else if (verb === 'candidate-reject') {
    if (!await confirm(ui, `Reject ${shown.name} ${short(shown.version)}?`, 'Reject candidate')) return;
    request(ui, 'candidate.reject', { id: shown.id, expectedRevision: shown.revision }); candidate(ui, shown.id);
  } else if (verb === 'profiles') profiles(ui);
  else if (verb === 'profile-history') {
    const current = (request(ui, 'profiles', {}, false).profiles || []).find(item => item.target === argument);
    if (!current) throw new Error('Choose the user or computer profile.'); profileHistory(ui, current);
  } else if (verb === 'profile-history-next' || verb === 'profile-history-previous') profileHistory(ui, shown, Math.max(0, shown.offset + (verb.endsWith('next') ? 5 : -5)));
  else if (verb === 'restore-profile') {
    if (!await confirm(ui, `Restore the displayed ${shown.target} profile revision ${argument}?`)) return;
    request(ui, 'profile.rollback', { target: shown.target, fromRevision: Number(argument), expectedRevision: shown.headRevision, reviewed: true }, false); profiles(ui);
  }
  else if (verb === 'edit-profile') {
    const current = (request(ui, 'profiles', {}, false).profiles || []).find(profile => profile.target === argument);
    if (!current) throw new Error('Choose the user or computer profile.');
    const text = await prompt(ui, 'ask', `${argument} profile · blank clears · current: ${current.text || '(empty)'}`);
    if (text != null) show(ui, 'profile-edit', { target: argument, text, expectedRevision: current.revision });
  } else if (verb === 'save-profile') {
    if (!await confirm(ui, `Save the displayed ${shown.target} profile?`)) return;
    request(ui, 'profile.update', { ...shown, reviewed: true }, false); profiles(ui);
  } else if (verb === 'proposals') proposals(ui);
  else if (verb === 'proposals-next' || verb === 'proposals-previous') { ui.knowledgeProposalOffset = Math.max(0, (ui.knowledgeProposalOffset || 0) + (verb.endsWith('next') ? 20 : -20)); proposals(ui); }
  else if (verb === 'proposal') {
    const proposal = (shown.items || []).find(item => item.id === argument); if (!proposal) throw new Error('Refresh profile proposals before reviewing.'); show(ui, 'proposal', proposal);
  } else if (verb === 'accept-proposal' || verb === 'reject-proposal') {
    const choice = verb.startsWith('accept') ? 'accept' : 'reject';
    if (!await confirm(ui, `${choice === 'accept' ? 'Accept' : 'Reject'} this exact ${shown.target} profile proposal?`)) return;
    request(ui, 'profile.review', { id: shown.id, action: choice, expectedRevision: shown.revision, reviewed: true }, false); proposals(ui);
  } else if (verb === 'fixtures') fixtures(ui);
  else if (verb === 'fixture') fixture(ui, argument);
  else if (verb === 'fixture-read-next' || verb === 'fixture-read-previous') fixture(ui, shown.id, Math.max(0, shown.offset + (verb.endsWith('next') ? 12000 : -12000)));
  else if (verb === 'revoke-fixtures') {
    if (!await confirm(ui, `Revoke ${shown.name} revision ${shown.revision}? Its evaluations can no longer authorize candidates.`, 'Revoke approval')) return;
    request(ui, 'fixtures.revoke', { id: shown.id, expectedRevision: shown.revision }); fixture(ui, shown.id);
  }
  else if (verb === 'import-fixtures') {
    const file = (await prompt(ui, 'ask', 'Offline fixture JSON file · no scripts or target requests will run'))?.trim(); if (!file) return;
    const definition = readFixtureJSON(file), scope = await prompt(ui, 'chooseOne', 'Offline fixture scope', [{ value: 'project', label: 'This project', selected: true }, { value: 'global', label: 'Global synthetic cases' }]);
    if (scope) show(ui, 'fixture-import', { definition, scope, offset: 0 });
  } else if (verb === 'fixture-next' || verb === 'fixture-previous') show(ui, 'fixture-import', { ...shown, offset: Math.max(0, (shown.offset || 0) + (verb.endsWith('next') ? 12000 : -12000)) });
  else if (verb === 'register-fixtures') {
    if (!await confirm(ui, `Approve these exact ${shown.definition?.cases?.length || 0} offline cases for ${shown.scope}?`, 'Approve cases')) return;
    request(ui, 'fixtures.register', { definition: shown.definition, scope: shown.scope, reviewed: true, requestId: randomUUID() }); fixtures(ui);
  } else if (verb === 'refresh') refresh(ui);
  else throw new Error('Choose a knowledge action from the Skills panel.');
}

export async function knowledgeCommand(text, ui, { api: injected } = {}) {
  if (!/^\/(?:memory|learn)(?:\s|$)/.test(text)) return false;
  if (injected) ui.knowledgeAPI = injected;
  ui.openTerminal();
  if (!ui.tui) { ui.event('error', { message: 'Open the interactive terminal to browse project memory and learning.' }); return true; }
  ui.tui.setPanel('skills');
  try {
    if (/^\/memory(?:\s|$)/.test(text)) { ui.knowledgeQuery = text.slice(7).trim(); ui.knowledgeOffset = 0; search(ui); }
    else {
      const input = text.slice(6).trim();
      if (!input) overview(ui);
      else if (['review', 'jobs', 'candidates', 'profiles', 'fixtures', 'settings'].includes(input)) await knowledgeAction(input, ui);
      else {
        const match = /^(pause|resume|cancel)\s+(\S+)$/.exec(input);
        if (!match) throw new Error('Use /learn, /learn review, or /learn pause|resume|cancel JOB_ID.');
        job(ui, match[2]); await knowledgeAction(match[1] + '-job', ui);
      }
    }
  } catch (error) { ui.event('error', { message: errorMessage(error) }); }
  finally { invalidate(ui); }
  return true;
}
