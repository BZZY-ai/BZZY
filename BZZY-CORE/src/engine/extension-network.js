import https from 'node:https';
import dns from 'node:dns/promises';
import net from 'node:net';

// Extensions have a deliberately small HTTP capability: fixed public HTTPS
// destinations, GET only, no redirects, proxy inheritance or cookie jar.
export function publicExtensionAddress(address) {
  if (net.isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254
      || a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0)
      || a === 100 && b >= 64 && b <= 127 || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)
      || a === 203 && b === 0 && c === 113);
  }
  // Only global unicast IPv6; excludes mapped IPv4, local, multicast,
  // documentation, transition and translation ranges.
  if (net.isIP(address) !== 6) return false;
  const value = new URL(`http://[${address}]/`).hostname.slice(1, -1).toLowerCase();
  return /^[23]/.test(value) && !/^(?:2001:(?::|(?:db8|0|2|10|20):)|2002:|3fff:)/.test(value);
}
export function extensionURL(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Extension requests require a fixed public HTTPS URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search || url.port && url.port !== '443'
    || net.isIP(url.hostname.replace(/^\[|\]$/g, '')) || !url.hostname.includes('.') || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(url.hostname)) {
    throw new Error('Extension requests require a public HTTPS hostname on port 443, without credentials, query or fragment.');
  }
  return url;
}
export async function requestExtensionJSON(url, headers, { signal } = {}) {
  signal = signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
  let onAbort;
  try {
    signal?.throwIfAborted();
    const addresses = await Promise.race([dns.lookup(url.hostname, { all: true, verbatim: true }), new Promise((_, reject) => { onAbort = () => reject(new Error()); signal.addEventListener('abort', onAbort, { once: true }); })]);
    signal?.throwIfAborted();
    if (!addresses.length || addresses.some(item => !publicExtensionAddress(item.address))) throw new Error();
    const selected = addresses[0];
    return await new Promise((resolve, reject) => {
      const request = https.get(url, { headers: { Accept: 'application/json', ...headers }, signal,
        // Pin the validated DNS answer for the actual socket (including TLS).
        lookup: (_host, options, done) => options?.all ? done(null, [selected]) : done(null, selected.address, selected.family),
      }, response => {
        if (response.statusCode < 200 || response.statusCode >= 300) { response.destroy(); reject(new Error()); return; }
        const chunks = []; let bytes = 0;
        response.on('data', chunk => { bytes += chunk.length; if (bytes > 1024 * 1024) { response.destroy(); reject(new Error()); } else chunks.push(chunk); });
        response.on('error', reject);
        response.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error()); } });
      });
      const timer = setTimeout(() => request.destroy(new Error()), 15_000); timer.unref();
      request.once('close', () => clearTimeout(timer)); request.once('error', reject);
    });
  } catch { throw new Error('Extension HTTPS read failed (destination, connection, status, timeout or JSON size/format).'); }
  finally { if (onAbort) signal.removeEventListener('abort', onAbort); }
}
