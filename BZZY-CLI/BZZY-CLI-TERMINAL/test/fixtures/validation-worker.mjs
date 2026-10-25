// Offline provider fixture for the actual Core tool bridge and worker runtime.
export async function runValidationWorker({ call, context, claude, prompt }) {
  const marker = context.contract?.context || '', final = marker.includes('FINAL GOAL REVIEW');
  const scenario = process.env.BZZY_TEST_ADVANCED;
  const repairReport = scenario === 'debate-report-repair';
  let followup = false;
  try { followup = Boolean(JSON.parse(prompt.split('FOLLOW-UP:\n').at(-1)).feedback); } catch {}
  const original = context.mission?.goal?.objective || context.contract.objective;
  const criteria = context.mission?.acceptanceCriteria || [];
  const inspected = [];
  for (const item of context.mission?.evidence || []) {
    let offset = 0;
    do {
      const page = await call('read_artifact', { id: item.id, offset, limit: 16000 });
      if (page.importedEvidenceId && !inspected.includes(page.importedEvidenceId)) inspected.push(page.importedEvidenceId);
      if (!page.truncated) break;
      if (page.nextOffset <= offset) throw new Error('Evidence pagination did not progress.');
      offset = page.nextOffset;
    } while (true);
  }
  const missing = scenario === 'debate-no-evidence';
  const evidence = missing ? [] : [(await call('record_evidence', { path: 'BZZY_SELECTED_MATERIAL.txt', label: 'validation-control-evidence' })).id];
  for (const id of evidence) await call('read_artifact', { id });
  let achieved = ['debate-agreement', 'debate-final-inconclusive', 'debate-report-repair'].includes(scenario) ? true : null;
  if (scenario === 'debate-false') achieved = claude ? false : true;
  if (scenario === 'debate-resolve-uncertain') achieved = claude && !followup ? null : true;
  if (final && scenario === 'debate-final-inconclusive') achieved = null;
  const rationale = achieved === true ? 'The inspected supplied controls support the exact original requirement.'
    : achieved === false ? 'A supplied control contradicts this original requirement.' : 'A required independent control remains unavailable.';
  const summary = achieved === true ? 'The supplied answer satisfies the original goal. I inspected the recorded control evidence.'
    : achieved === false ? 'The supplied answer does not satisfy an original requirement. The recorded control contradicts the claim.'
      : 'The supplied answer could not be confirmed. A required control is still missing.';
  const report = { status: achieved === null ? 'inconclusive' : 'complete', summary, evidence,
    validationAssessment: { objective: original, achieved, criteria: criteria.map(item => ({ id: item.id, achieved, rationale, evidence })) },
    objections: [], uncertainties: [], conclusions: achieved === true ? ['The original fixture requirement is supported.'] : [], position: summary,
    ...(final ? { decision: { acceptedConclusions: achieved === true ? ['The original fixture goal is supported.'] : [], rejectedClaims: [], corrections: [],
      remainingObjections: [], nextVerificationSteps: achieved === null ? ['Obtain the missing independent control.'] : [], objectionDispositions: [],
      goalSatisfaction: achieved === true ? 'supported' : 'inconclusive', goalAssessment: { objective: original, rationale, evidence,
        criteria: criteria.map(item => ({ id: item.id, status: achieved === true ? 'supported' : 'inconclusive', rationale, evidence })) } } } : {}),
  };
  if (repairReport && !final) {
    delete report.objections;
    report.uncertainties = ['The supplied control was not compared with an external source; the original criterion concerns the supplied evidence.'];
  }
  if (repairReport && final) {
    const ledger = JSON.parse(marker.split('PERSISTENT OBJECTIONS:\n').at(-1));
    if (!ledger.length || ledger.some(item => item.kind !== 'uncertainty' || item.invalid)) throw new Error('The final reviewer needs the actual informational caveats, without fabricated malformed reports.');
    report.decision.objectionDispositions = ledger.map(item => ({ id: item.id, status: 'rejected',
      rationale: 'The inspected supplied evidence supports the original criterion. The absence of an external comparison adds no requirement to that criterion.', evidence }));
    const rejected = async (candidate, field) => {
      try { await call('finish_assignment', candidate); }
      catch (error) { if (error.message.includes(field)) return; throw error; }
      throw new Error('The fixture expected an actionable report-format error for ' + field);
    };
    await rejected({ ...report, decision: { ...report.decision, goalSatisfaction: true } }, 'goalSatisfaction');
    const wrongDispositions = report.decision.objectionDispositions.map(({ status, ...item }) => ({ ...item, disposition: status }));
    await rejected({ ...report, decision: { ...report.decision, objectionDispositions: wrongDispositions } }, 'status');
    report.summary += ' I corrected both rejected report formats in this same worker round.';
  }
  await call('finish_assignment', report);
}
