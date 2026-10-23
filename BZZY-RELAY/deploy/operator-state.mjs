// Deterministic local operator inspection. Public certificates only; no endpoint
// identities, account bindings, environment dumps or application payloads.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { verifyCertificate } from './release/src/identity.js';

const [operation, directory, certificateFile, beforeFile] = process.argv.slice(2);
let db;
try {
  const certificate = JSON.parse(fs.readFileSync(certificateFile, 'utf8'));
  verifyCertificate(certificate); // Strict public-field schema; rejects secrets.
  if (operation === 'certificate') {
    console.log(JSON.stringify({ id: certificate.id, publicOnly: true }));
  } else {
    db = new DatabaseSync(path.join(directory, 'relay.sqlite'), { readOnly: true });
    const schema = db.prepare("SELECT value FROM metadata WHERE key='schema'").get()?.value;
    if (schema !== '1' || Object.values(db.prepare('PRAGMA quick_check').get())[0] !== 'ok') throw Error();
    const read = table => db.prepare(`SELECT id,data FROM ${table}`).all().map(row => ({ id: row.id, ...JSON.parse(row.data) }));
    const devices = read('devices'), grants = read('grants'), invitations = read('invitations');
    const host = devices.find(row => row.id === certificate.id);
    const enrolled = Boolean(host?.role === 'host' && !host.revokedAt && ['v', 'id', 'signKey', 'boxKey', 'signature'].every(key => host.certificate?.[key] === certificate[key]));
    if (operation === 'snapshot') {
      console.log(JSON.stringify({ schema,
        revokedDevices: devices.filter(row => row.revokedAt).map(row => ({ id: row.id, revokedAt: row.revokedAt })),
        revokedGrants: grants.filter(row => row.revokedAt).map(row => ({ id: row.id, revokedAt: row.revokedAt })),
        spentInvitations: invitations.filter(row => row.state !== 'open').map(row => ({ id: row.id, state: row.state })) }));
    } else if (operation === 'verify') {
      const before = JSON.parse(fs.readFileSync(beforeFile, 'utf8'));
      if (before.schema !== schema || !enrolled) throw Error();
      for (const row of before.revokedDevices) if (!devices.find(item => item.id === row.id)?.revokedAt) throw Error();
      for (const row of before.revokedGrants) {
        const current = grants.find(item => item.id === row.id);
        if (current && !current.revokedAt) throw Error(); // Pruned/missing is denied.
      }
      for (const row of before.spentInvitations) {
        const current = invitations.find(item => item.id === row.id);
        if (current && current.state !== row.state) throw Error();
      }
      console.log(JSON.stringify({ schema, denialsPreserved: true, hostEnrolled: true }));
    } else if (operation === 'host-ready') {
      if (!enrolled) throw Error();
      console.log(JSON.stringify({ hostEnrolled: true, id: certificate.id }));
    } else throw Error();
  }
} catch {
  process.stderr.write('Operator state/certificate verification failed; keep Relay stopped for review.\n');
  process.exitCode = 1;
} finally { db?.close(); }
