const phases = {
  session: 'Reading the saved chat', destination: 'Preparing output', staging: 'Preparing private staging',
  overview: 'Writing overview', history: 'Reading saved history', workspace: 'Capturing project files',
  resources: 'Capturing evidence and resources', manifest: 'Writing manifest', packaging: 'Packaging ZIP', complete: 'ZIP ready',
};
const counters = ['elapsedMs', 'records', 'events', 'files', 'bytes', 'exclusions', 'packagedFiles', 'packagedBytes', 'inspectedBytes'];
const count = value => Number.isSafeInteger(value) && value >= 0;
const duration = milliseconds => {
  const seconds = Math.floor(Math.max(0, milliseconds) / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
};
const size = bytes => bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KiB`
  : bytes < 1024 ** 3 ? `${(bytes / 1024 ** 2).toFixed(1)} MiB` : `${(bytes / 1024 ** 3).toFixed(2)} GiB`;

// Progress never includes source paths, exception strings or captured text.
export function safeDebugExportProgress(value) {
  if (!value || !Object.hasOwn(phases, value.phase)) return null;
  return { phase: value.phase, ...Object.fromEntries(counters.filter(key => count(value[key])).map(key => [key, value[key]])) };
}

export function debugExportContextNotice(result) {
  return result?.full === true && result.contextLimited === true
    ? 'Project file capture reached its budget. Saved session history and memory streams are retained; some project or evidence files are omitted. Check manifest.exclusions inside the ZIP.'
    : null;
}

export function debugExportSummary(result) {
  if (result?.full !== true) return null;
  const details = [result.captureMode === 'bounded' ? 'Bounded capture' : result.captureMode === 'complete' ? 'Complete capture' : 'Full capture'];
  if (count(result.files)) details.push(`${result.files.toLocaleString()} files`);
  if (count(result.uncompressedBytes)) details.push(`${size(result.uncompressedBytes)} captured`);
  if (count(result.bytes)) details.push(`${size(result.bytes)} ZIP`);
  return details.join(' · ');
}

export function debugExportProgressLines(value, { elapsedMs = 0, quietMs = 0, captureMode } = {}) {
  const progress = safeDebugExportProgress(value) || { phase: 'session' };
  const mode = captureMode === 'bounded' ? ' · bounded capture' : captureMode === 'complete' ? ' · complete capture' : '';
  const lines = [`Full debug ZIP${mode} · ${phases[progress.phase]} · ${duration(Math.max(elapsedMs, progress.elapsedMs || 0))} elapsed`];
  const details = ['records', 'events', 'files'].filter(key => count(progress[key])).map(key => `${progress[key].toLocaleString()} ${key}`);
  if (count(progress.bytes)) details.push(`${size(progress.bytes)} captured`);
  if (progress.inspectedBytes) details.push(`${size(progress.inspectedBytes)} scanned`);
  if (details.length) lines.push(details.join(' · '));
  if (progress.phase === 'packaging' && (count(progress.packagedFiles) || count(progress.packagedBytes))) {
    lines.push([count(progress.packagedFiles) ? `${progress.packagedFiles.toLocaleString()} files packaged` : null,
      count(progress.packagedBytes) ? `${size(progress.packagedBytes)} processed` : null].filter(Boolean).join(' · '));
  }
  if (progress.exclusions) lines.push(`${progress.exclusions.toLocaleString()} capture omissions · see the ZIP manifest`);
  if (quietMs >= 10000 && progress.phase !== 'complete') lines.push(`Last progress update ${duration(quietMs)} ago · waiting for the exporter`);
  return lines;
}

// Keep stdout reserved for the command's final result, including --json output.
export function createDebugExportProgressReporter({ stream = process.stderr, now = Date.now, captureMode } = {}) {
  const startedAt = now(); let updatedAt = startedAt, lastPrintedAt = -Infinity, progress = { phase: 'session' }, closed = false, wrote = false;
  const render = force => {
    if (closed || !force && !stream.isTTY && now() - lastPrintedAt < 5000) return;
    const elapsedMs = Math.max(now() - startedAt, progress.elapsedMs || 0), quietMs = now() - updatedAt;
    const lines = debugExportProgressLines(progress, { elapsedMs, quietMs, captureMode });
    // A narrow one-line terminal must show a quiet worker before optional
    // counters. The elapsed timer alone is not evidence that work advanced.
    const line = stream.isTTY && quietMs >= 10000 && progress.phase !== 'complete'
      ? `Full debug ZIP · ${duration(elapsedMs)} elapsed · last update ${duration(quietMs)} ago · ${phases[progress.phase]}`
      : lines.join(' · ');
    try {
      stream.write(stream.isTTY ? `\r\x1b[2K${line.slice(0, Math.max(20, (stream.columns || 100) - 1))}` : line + '\n');
      wrote = true; lastPrintedAt = now();
    } catch { /* A diagnostic display failure cannot change an export result. */ }
  };
  render(true);
  const timer = setInterval(() => render(false), 1000); timer.unref?.();
  return {
    update(value) {
      if (closed) return;
      const next = safeDebugExportProgress(value); if (!next) return;
      const changedPhase = next.phase !== progress.phase;
      progress = next; updatedAt = now(); render(changedPhase);
    },
    close() {
      if (closed) return;
      clearInterval(timer); closed = true;
      if (wrote && stream.isTTY) { try { stream.write('\n'); } catch { /* Ignore display failures. */ } }
    },
  };
}
