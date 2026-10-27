import fs from 'node:fs';

const requireCondition = (condition, message) => { if (!condition) throw new Error(message); };

// Deterministic agents exercise the host's real assignment/evidence/control flow
// against a test-owned loopback service. No model or external target is contacted.
export async function runDelegationCTF({ call, context, prompt, has }) {
  async function wait(job) {
    let state = typeof job.round === 'object' ? job : await call('wait_assignment', { id: job.id, timeoutSeconds: 20 });
    while (['starting', 'running'].includes(state.round.state)) state = await call('wait_assignment', { id: job.id, timeoutSeconds: 20 });
    requireCondition(state.round.state === 'awaiting_review', JSON.stringify(state));
    return state;
  }
  if (has('delegate')) {
    const setup = JSON.parse(fs.readFileSync('challenge.json', 'utf8'));
    await call('checkpoint', { decisions: [{ decision: 'Delegate response collection; independently verify the ownership boundary before accepting a flag.' }], pendingActions: ['Collect candidate', 'Compare controls', 'Independently reproduce and save the verified proof'] });
    const config = await call('record_evidence', { path: 'challenge.json', label: 'selected-challenge-input' });
    const first = await wait(await call('delegate', { requestId: 'collect-profile-candidate',
      objective: 'Collect one candidate response from the supplied CTF profile route', context: 'Read the selected challenge input. Return response evidence, not a parent completion claim.',
      evidence: [config.id], acceptanceCriteria: ['A reproducible response artifact exists; any ownership claim distinguishes observations from missing controls.'], limits: { runtimeSeconds: 30 } }));
    const candidateId = first.round.report.evidence[0];
    const candidate = await call('read_artifact', { id: candidateId });
    requireCondition(candidate.content.includes('flag'), 'Candidate response was not inspected');
    // A flag-like field alone is insufficient; the supervisor explicitly asks for controls.
    await call('checkpoint', { decisions: [{ decision: 'Do not accept the worker claim yet: the unauthenticated and owned-object controls are missing.', evidence: [candidate.importedEvidenceId] }], pendingActions: ['Ask the same worker for controls', 'Reproduce the decisive request independently'] });
    const reviewed = await wait(await call('followup_assignment', { id: first.id, requestId: 'collect-ownership-controls',
      feedback: 'The candidate alone does not prove an ownership bypass. Compare owned, foreign and unauthenticated requests before acceptance.',
      objective: 'Collect the owned-object, foreign-object and unauthenticated controls and return linked evidence.' }));
    for (const id of reviewed.round.report.evidence) await call('read_artifact', { id });
    const control = await call('http_request', { url: setup.baseUrl + '/profile?user_id=2', headers: { authorization: 'Bearer fixture-account-a' } });
    const bytes = await call('read_artifact', { id: control.evidence });
    const verified = JSON.parse(bytes.content); requireCondition(control.status === 200 && /^BZZY_CTF\{/.test(verified.flag), 'Independent reproduction did not establish the flag');
    await call('review_assignment', { id: first.id, outcome: 'accepted', rationale: 'Inspected the worker controls and independently reproduced the foreign-object response.', evidence: reviewed.round.report.evidence });
    fs.writeFileSync('ctf-proof.json', JSON.stringify({ flag: verified.flag, verifiedBy: 'supervisor', workerAssignment: first.id, controlEvidence: reviewed.round.report.evidence, independentEvidence: control.evidence }));
    const proof = await call('record_evidence', { path: 'ctf-proof.json', label: 'verified-ctf-proof' });
    await call('assess_requirement', { id: 'ctf', status: 'supported', rationale: 'The foreign profile was reproduced independently after collecting account and unauthenticated controls.', evidence: [proof.id, control.evidence] });
    await call('checkpoint', { completedWork: ['Collected candidate', 'Rejected premature acceptance', 'Collected controls in the same worker conversation', 'Independently verified and saved the CTF proof'], pendingActions: [], evidence: [proof.id] });
    return { tokens: 42, text: 'The supervisor verified the CTF flag with controls; proof is saved in ctf-proof.json.\n' };
  }
  requireCondition(has('finish_assignment'), 'CTF executor is missing its bounded report tool');
  requireCondition(!JSON.stringify(context).includes('PARENT_PRIVATE_LEDGER_MARKER'), 'Worker received unrelated parent project history');
  const selected = context.selectedEvidence?.[0]; requireCondition(selected, 'Supervisor input evidence was not shared');
  const input = await call('read_artifact', { id: selected.id }); const setup = JSON.parse(input.content);
  // The current explicit round request drives this fixture. A prior round's
  // checkpoint is historical progress, never the new round's current state.
  const currentRound = JSON.parse(prompt.split('FOLLOW-UP:\n').at(-1));
  const followup = currentRound.feedback?.includes('Compare owned, foreign and unauthenticated requests') === true;
  const evidence = [];
  const requests = followup ? [
    { id: 1, headers: { authorization: 'Bearer fixture-account-a' }, status: 200 },
    { id: 2, headers: { authorization: 'Bearer fixture-account-a' }, status: 200 },
    { id: 2, headers: {}, status: 401 },
  ] : [{ id: 2, headers: { authorization: 'Bearer fixture-account-a' }, status: 200 }];
  for (const request of requests) {
    const result = await call('http_request', { url: setup.baseUrl + '/profile?user_id=' + request.id, headers: request.headers });
    requireCondition(result.status === request.status, 'Unexpected local CTF control status'); evidence.push(result.evidence);
  }
  await call('checkpoint', { completedWork: ['candidate-collected', ...(followup ? ['controls-collected'] : [])], pendingActions: followup ? [] : ['Ownership controls need supervisor review'], evidence });
  await call('finish_assignment', { status: 'complete', summary: followup ? 'Owned and foreign requests succeeded; an unauthenticated request was denied. The supervisor must review the ownership evidence.' : 'A flag-like field was returned. No ownership controls were collected yet.', evidence,
    uncertainties: followup ? [] : ['A candidate response alone does not establish an ownership bypass.'] });
  return { tokens: followup ? 84 : 42, text: followup ? 'Control evidence returned for supervisor review.\n' : 'Candidate evidence returned for supervisor review.\n' };
}
