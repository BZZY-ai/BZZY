import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { home, privateDir } from './files.js';
import { getRecord, putRecord, listRecords, reserveRequest, transaction, now } from './database.js';
import { runtimeEnv } from './process.js';
import { processIdentity, identityAlive } from './process-identity.js';
import { checkInstallationUpdate, installationDirectory } from './update-check.js';
import { requireUpdateGrant, authorizedUpdateGrant, updateDeviceKey, updateDevicePreferences } from './update-access.js';
import { object, opaque, fail } from '../validation.js';

const active = ['queued', 'installing'];
const validTarget = value => typeof value === 'string' && /^[a-f0-9]{40,64}$/.test(value);
const publicJob = job => job && ({ id: job.id, state: job.state, target: job.target, requestId: job.requestId, createdAt: job.createdAt, updatedAt: job.updatedAt, code: job.code || null });
export class CoreUpdates {
  #home = home(); #timer; #checking; #launches = new Map(); #abort = new AbortController();
  constructor({ checker = checkInstallationUpdate, launch, directory = installationDirectory, clock = Date.now } = {}) {
    Object.assign(this, { checker, launcher: launch, directory, clock });
  }
  #checkHome() { if (home() !== this.#home) fail('HOST_CONTEXT_CHANGED', 'The update host changed.', 409); }
  status(row) {
    this.#checkHome(); row = requireUpdateGrant(row);
    const saved = getRecord('core.update.status', 'default') || { phase: 'unchecked', available: false };
    const preferences = updateDevicePreferences(row);
    const job = listRecords('core.update.job', { limit: 100 }).find(job => job.peerId === row.peerId && job.hostId === row.hostId);
    const monitoringEnabled = getRecord('core.update.preferences', 'default')?.monitoringEnabled !== false;
    return { ...saved, monitoringEnabled, notificationsEnabled: preferences.notificationsEnabled !== false,
      remoteUpdatesEnabled: preferences.remoteUpdatesEnabled === true,
      canInstall: !listRecords('core.update.job', { states: active, limit: 1 }).length && saved.phase === 'ready' && saved.available === true && !saved.blocked && Boolean(this.directory()) && preferences.remoteUpdatesEnabled === true,
      job: publicJob(job) || null };
  }
  configure(row, params) {
    this.#checkHome(); row = requireUpdateGrant(row);
    object(params, ['monitoringEnabled', 'notificationsEnabled', 'remoteUpdatesEnabled']);
    if (!Object.keys(params).length || Object.values(params).some(value => typeof value !== 'boolean')) fail('INVALID_REQUEST', 'Use explicit boolean update preferences.');
    transaction(db => {
      requireUpdateGrant(row);
      const { monitoringEnabled, ...device } = params;
      if (monitoringEnabled !== undefined) putRecord('core.update.preferences', 'default', { monitoringEnabled, updatedAt: now() }, db);
      putRecord('core.update.device', updateDeviceKey(row), { ...updateDevicePreferences(row), ...device, updatedAt: now() }, db);
    });
    return this.status(row);
  }
  async checkNow(row) { requireUpdateGrant(row); await this.check(); return this.status(row); }
  async check({ force = false } = {}) {
    this.#checkHome();
    const previous = getRecord('core.update.status', 'default');
    if (!force && previous?.checkedAt && this.clock() - previous.checkedAt < 60000) return previous;
    if (this.#checking) return this.#checking;
    this.#checking = (async () => {
      try {
        const check = await this.checker({ directory: this.directory(), signal: AbortSignal.any([this.#abort.signal, AbortSignal.timeout(12000)]) });
        const status = { phase: 'ready', current: check.current, target: check.target, available: check.available,
          blocked: check.blocked || null, checkedAt: this.clock() };
        putRecord('core.update.status', 'default', status);
        if (status.available && !status.blocked && validTarget(status.target)) {
          const key = 'system-update-' + status.target;
          if (!getRecord('outbox', key)) putRecord('outbox', key, { event: { version: 1, id: randomUUID(), type: 'system.update_available',
            occurredAt: now(), current: status.current, target: status.target }, deliveries: {} });
        }
        return status;
      } catch {
        if (this.#abort.signal.aborted) return previous;
        const status = { phase: 'unavailable', available: false, checkedAt: this.clock(), blocked: 'GitHub update check unavailable. Check host connectivity and repository access.' };
        putRecord('core.update.status', 'default', status); return status;
      }
    })();
    try { return await this.#checking; } finally { this.#checking = null; }
  }
  requestInstall(row, params, requestId) {
    this.#checkHome(); row = requireUpdateGrant(row); opaque(requestId);
    object(params, ['target']);
    if (!validTarget(params.target)) fail('INVALID_REQUEST', 'Choose the checked update revision.');
    const result = reserveRequest('core:update:' + updateDeviceKey(row), requestId, params, db => {
      requireUpdateGrant(row);
      if (!updateDevicePreferences(row).remoteUpdatesEnabled) fail('FORBIDDEN', 'Enable remote updates on this paired phone first.', 403);
      const status = getRecord('core.update.status', 'default');
      if (status?.phase !== 'ready' || !status.available || status.blocked || status.target !== params.target || this.clock() - status.checkedAt > 3600000) fail('CONFLICT', 'Refresh the available revision before updating.', 409);
      if (listRecords('core.update.job', { states: active, limit: 1 }).length) fail('CONFLICT', 'Another update is already in progress.', 409);
      const directory = this.directory();
      if (!directory) fail('CONFLICT', 'The combined installation is unavailable.', 409);
      const job = { id: randomUUID(), requestId, state: 'queued', target: params.target, directory, grantId: row.id, resource: row.resource,
        hostId: row.hostId, peerId: row.peerId, createdAt: now(), updatedAt: now() };
      putRecord('core.update.job', job.id, job, db); return { jobId: job.id, target: job.target, state: 'queued' };
    });
    this.schedule(result.jobId); return result;
  }
  schedule(id) {
    if (this.#launches.has(id)) return;
    const timer = setTimeout(() => { this.#launches.delete(id); this.launch(id); }, 750); timer.unref(); this.#launches.set(id, timer);
  }
  launch(id) {
    this.#checkHome(); const job = getRecord('core.update.job', id);
    if (!job || job.state !== 'queued' || identityAlive(job.helper)) return;
    const row = authorizedUpdateGrant(job.grantId);
    if (!row || row.resource !== job.resource || !updateDevicePreferences(row).remoteUpdatesEnabled) {
      putRecord('core.update.job', id, { ...job, state: 'failed', code: 'FORBIDDEN', updatedAt: now() }); return;
    }
    if (this.launcher) { this.launcher(job); return; }
    const folder = path.join(home(), 'runtime'); privateDir(folder);
    const fd = fs.openSync(path.join(folder, `update-${id}.log`), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW, 0o600);
    try {
      const child = spawn(process.execPath, [fileURLToPath(new URL('../../bin/bzzy-engine.js', import.meta.url)), 'internal-update', id], {
        cwd: home(), env: runtimeEnv({ BZZY_HOME: home() }), detached: true, stdio: ['ignore', fd, fd] });
      if (Number.isSafeInteger(child.pid)) putRecord('core.update.job', id, { ...job, helper: processIdentity(child.pid), updatedAt: now() });
      child.once('error', () => { const fresh = getRecord('core.update.job', id); if (fresh?.state === 'queued') putRecord('core.update.job', id, { ...fresh, state: 'failed', code: 'UPDATE_START_FAILED', updatedAt: now() }); });
      child.unref();
    } finally { fs.closeSync(fd); }
  }
  start() {
    if (this.#timer) return this;
    if (this.#abort.signal.aborted) this.#abort = new AbortController();
    for (const job of listRecords('core.update.job', { states: active })) {
      if (job.state === 'queued') this.schedule(job.id);
      else if (!identityAlive(job.helper)) putRecord('core.update.job', job.id, { ...job, state: 'uncertain', code: 'UPDATE_INTERRUPTED', updatedAt: now() });
    }
    let first = true;
    const tick = () => {
      if (getRecord('core.update.preferences', 'default')?.monitoringEnabled === false) return;
      if (!listRecords('core.relay.grant').some(row => authorizedUpdateGrant(row.id))) return;
      const force = first; first = false; void this.check({ force }).catch(() => {});
    };
    this.#timer = setInterval(tick, 15 * 60000); this.#timer.unref(); tick(); return this;
  }
  close() { this.#abort.abort(); clearInterval(this.#timer); this.#timer = null; for (const timer of this.#launches.values()) clearTimeout(timer); this.#launches.clear(); }
}
let instance, instanceHome;
export function coreUpdates() {
  if (!instance || instanceHome !== home()) { instance?.close(); instance = new CoreUpdates(); instanceHome = home(); }
  return instance;
}
export async function runUpdateJob(id) {
  if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) fail('INVALID_REQUEST', 'Invalid update job.');
  const job = transaction(db => {
    const current = getRecord('core.update.job', id);
    if (!current || current.state !== 'queued') return null;
    const row = authorizedUpdateGrant(current.grantId);
    if (!row || row.resource !== current.resource || !updateDevicePreferences(row).remoteUpdatesEnabled) {
      putRecord('core.update.job', id, { ...current, state: 'failed', code: 'FORBIDDEN', updatedAt: now() }, db); return null;
    }
    const updated = { ...current, state: 'installing', helper: processIdentity(process.pid), updatedAt: now() };
    putRecord('core.update.job', id, updated, db); return updated;
  });
  if (!job) return 0;
  try {
    const fresh = await checkInstallationUpdate({ directory: job.directory });
    if (fresh.blocked || fresh.target !== job.target) throw Object.assign(new Error('Update revision changed.'), { code: 'CONFLICT' });
    const { updateCoreAndCLI } = await import('./source-update.js');
    await updateCoreAndCLI(job.directory, { expectedCommit: job.target });
    putRecord('core.update.job', id, { ...getRecord('core.update.job', id), state: 'installed', updatedAt: now() }); return 0;
  } catch (error) {
    putRecord('core.update.job', id, { ...getRecord('core.update.job', id), state: 'failed', code: ['FORBIDDEN', 'CONFLICT'].includes(error.code) ? error.code : 'UPDATE_FAILED', updatedAt: now() }); return 1;
  }
}
