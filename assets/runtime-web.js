const $ = id => document.getElementById(id);
const fragment = new URLSearchParams(location.hash.slice(1));
if (fragment.get('token')) sessionStorage.setItem('bzzyToken', fragment.get('token'));
const token = sessionStorage.getItem('bzzyToken') || '', owner = crypto.randomUUID();
let sessionId = fragment.get('session') || sessionStorage.getItem('bzzySession') || '', cursor = 0, question, controlling = false, busy = false;
let groupId = sessionId, tabsSignature = '', groupControlling = false, selectedSnapshot;
const activities = new Map(), requests = new Map();
history.replaceState(null, '', location.pathname);
async function api(method, path, body) {
  const response = await fetch(path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() }, ...(body ? { body: JSON.stringify({ ...body, owner }) } : {}) });
  const value = await response.json(); if (!response.ok) throw new Error(value.error); return value;
}
async function refresh() {
  const sessions = await api('GET', '/sessions'); $('sessions').replaceChildren(new Option('Select a conversation', ''));
  for (const s of sessions) $('sessions').append(new Option(`${s.id.slice(0, 8)} · ${s.provider} · ${s.contract?.objective?.slice(0, 50) || s.cwd}`, s.id));
  $('sessions').value = groupId;
}
function failure(error) { $('error').textContent = error.message; }
async function poll() {
  if (!sessionId || busy) return; busy = true;
  const pollingId = sessionId, pollingGroup = groupId;
  try {
    const group = await api('GET', `/sessions/${pollingGroup}`), snapshot = pollingGroup === pollingId ? group : await api('GET', `/sessions/${pollingId}`);
    if (sessionId !== pollingId || groupId !== pollingGroup) return;
    selectedSnapshot = snapshot;
    const tabs = [{ id: groupId, agent: 'Overview' }, ...(group.capabilities.chatTabs ? group.children : [])];
    const signature = JSON.stringify({ tabs, selected: sessionId });
    if (signature !== tabsSignature) {
      tabsSignature = signature; $('agent-tabs').replaceChildren();
      if (tabs.length > 1) for (const tab of tabs) {
        const button = document.createElement('button'); button.textContent = `${tab.agent} · ${tab.id.slice(0, 8)}`; button.setAttribute('aria-pressed', String(tab.id === sessionId));
        button.onclick = () => { sessionId = tab.id; cursor = 0; controlling = false; question = null; selectedSnapshot = null; $('status').textContent = 'Loading conversation…'; $('question').textContent = ''; $('history').textContent = ''; $('activities').textContent = ''; $('traffic').textContent = ''; activities.clear(); requests.clear(); poll(); };
        $('agent-tabs').append(button, document.createTextNode(' '));
      }
    }
    controlling = snapshot.inputOwner?.owner === owner && snapshot.inputOwner.expiresAt > Date.now();
    groupControlling = group.inputOwner?.owner === owner && group.inputOwner.expiresAt > Date.now();
    $('session').textContent = `Session: ${groupId}${groupId !== sessionId ? ` · Chat: ${sessionId}` : ''}`;
    $('status').textContent = `${controlling ? 'Input owner' : 'Read-only viewer'} · ${snapshot.session.executionState} · ${snapshot.session.goal?.status || 'chat'}`;
    question = snapshot.questions[0]; $('question').textContent = question?.question || '';
    const batch = await api('GET', `/sessions/${pollingId}/events?after=${cursor}&limit=500`);
    if (sessionId !== pollingId || groupId !== pollingGroup) return;
    for (const event of batch.events) {
      if (event.type === 'message.user') $('history').append(document.createTextNode(`\nYou${event.data.kind === 'goal' ? ' /goal' : ''} › ${event.data.text}\n\n`));
      else if (event.type === 'question') $('history').append(document.createTextNode(`\nAgent asks › ${event.data.question}\n`));
      else if (event.type === 'question.answered') $('history').append(document.createTextNode(`You › ${event.data.answer}\n\n`));
      else if (event.type === 'text') $('history').append(document.createTextNode(event.data.text));
      else if (event.type === 'peer.text') $('history').append(document.createTextNode(`[${event.data.agent}] ${event.data.text}`));
      else if (event.type === 'debate.message') $('history').append(document.createTextNode(`\n[${event.data.participant} · ${event.data.role}${event.data.round ? ` · round ${event.data.round}/${event.data.maxRounds}` : ''}]\n${event.data.text}\n`));
      else if (event.type === 'debate.result') $('history').append(document.createTextNode(`\n${event.data.message}\n`));
      else if (['tool', 'summary', 'error', 'info', 'worker.progress'].includes(event.type)) $('history').append(document.createTextNode(`\n${event.data.message || event.data.name || JSON.stringify(event.data)}\n`));
      if (event.type === 'activity') {
        let node = activities.get(event.data.id);
        if (!node) { node = document.createElement('details'); node.append(document.createElement('summary'), document.createElement('pre')); activities.set(event.data.id, node); $('activities').prepend(node); }
        node.firstChild.textContent = `[${event.data.agent}] ${event.data.summary} · ${event.data.closedAt ? 'execution ended' : event.data.status}`;
        node.lastChild.textContent = [event.data.details,
          event.data.observation ? `Observed: ${event.data.observation}` : '',
          event.data.inference ? `Interpretation: ${event.data.inference}` : '',
          event.data.nextCheck ? `Next: ${event.data.nextCheck}` : '',
          event.data.evidence?.length ? `Evidence: ${event.data.evidence.join(', ')}` : '',
          event.data.provenance === 'host-inferred' ? 'Automatic progress summary from tool activity.' : '',
          event.data.closedAt ? `Execution ended: ${event.data.closedAt} · ${event.data.executionOutcome}` : '',
        ].filter(Boolean).join('\n\n');
      }
      if (event.type === 'network.capture') $('coverage').textContent = event.data.coverage;
      if (['network.request', 'network.response', 'network.error'].includes(event.type) && event.data.id) {
        let node = requests.get(event.data.id);
        if (!node) { node = document.createElement('details'); node.append(document.createElement('summary'), document.createElement('pre')); requests.set(event.data.id, node); $('traffic').prepend(node); }
        node.firstChild.textContent = `${event.data.agent ? `[${event.data.agent}] ` : ''}${event.data.method} ${event.data.url} → ${event.data.status || event.data.message || 'pending'}${event.data.durationMs != null ? ` · ${event.data.durationMs}ms` : ''}`;
        node.lastChild.textContent = JSON.stringify(event.data, null, 2);
      }
      cursor = event.seq;
    }
  } catch (error) { failure(error); } finally { busy = false; }
}
$('sessions').onchange = () => { sessionId = $('sessions').value; groupId = sessionId; tabsSignature = ''; sessionStorage.setItem('bzzySession', sessionId); cursor = 0; controlling = false; groupControlling = false; $('history').textContent = ''; $('activities').textContent = ''; $('traffic').textContent = ''; activities.clear(); requests.clear(); poll(); };
for (const button of document.querySelectorAll('[data-panel]')) button.onclick = () => { for (const id of ['chat-panel', 'activity-panel', 'traffic-panel']) $(id).hidden = id !== button.dataset.panel; };
$('refresh').onclick = () => refresh().catch(failure);
$('claim').onclick = () => api('POST', `/sessions/${groupId}/claim`, { takeover: true }).then(poll).catch(failure);
for (const action of ['pause', 'cancel']) $(action).onclick = () => api('POST', `/sessions/${sessionId}/control`, { action }).catch(failure);
$('chat').onsubmit = async event => {
  event.preventDefault(); if (!controlling) { failure(new Error('Attach before sending input.')); return; }
  const text = $('message').value;
  try {
    if (question) await api('POST', `/sessions/${sessionId}/answer`, { questionId: question.id, answer: text });
    else {
      if (groupId === sessionId && document.querySelectorAll('#agent-tabs button').length > 1) throw new Error('Select an agent chat tab before sending a message.');
      if (['queued', 'launching', 'running'].includes(selectedSnapshot?.execution?.state)) {
        if (!selectedSnapshot.capabilities.activeSteering) throw new Error('This backend cannot accept text mid-turn. Pause, then send your next message.');
        await api('POST', `/sessions/${sessionId}/control`, { action: 'steer', text });
      } else await api('POST', `/sessions/${sessionId}/execute`, { prompt: text, options: {}, goal: false });
    }
    $('message').value = ''; $('error').textContent = '';
  } catch (error) { failure(error); }
};
setInterval(() => { if (groupControlling && groupId) api('POST', `/sessions/${groupId}/claim`, {}).catch(() => { groupControlling = false; controlling = false; }); }, 10000);
setInterval(poll, 500); refresh().then(poll).catch(failure);
