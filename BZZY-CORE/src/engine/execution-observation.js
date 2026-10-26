import { identityAlive } from './process-identity.js';

// Process observations are read-only and separate from output/progress. Bound
// OS sampling even when several clients poll the same execution frequently.
export function createExecutionObserver({ clock = Date.now, alive = identityAlive, intervalMs = 2000 } = {}) {
  const observations = new Map();
  return job => {
    const instant = clock(), identity = job?.runner;
    const key = JSON.stringify([job?.id, job?.state, identity]);
    const previous = observations.get(key);
    if (previous && instant >= previous.at && instant - previous.at < intervalMs) return { ...previous.value };
    let runnerAlive = null;
    if (['launching', 'running'].includes(job?.state) && Number.isSafeInteger(identity?.pid) && identity.pid > 0
      && typeof identity.start === 'string' && identity.start && identity.start !== 'platform-unverified') {
      try { runnerAlive = alive(identity) === true; } catch { /* Observation failure is unknown, never proof of life. */ }
    }
    const value = { executionId: job?.id || null, observedAt: new Date(instant).toISOString(), runnerAlive };
    if (observations.size >= 128) observations.delete(observations.keys().next().value);
    observations.set(key, { at: instant, value });
    return { ...value };
  };
}
