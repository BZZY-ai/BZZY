export const debugExportLimits = Object.freeze({
  stageBytes: 4 * 1024 ** 3, contextBytes: 512 * 1024 ** 2,
  manifestReserveBytes: 8 * 1024 ** 2, contextMetadataBytes: 4 * 1024 ** 2,
});

// Complete capture has no aggregate policy cap. Bounded capture reserves its
// stage budget for mandatory streams and the final inventory before optional files.
export function createDebugContextBudget({ captureMode, limitBytes,
  stageBytes = debugExportLimits.stageBytes, manifestReserveBytes = debugExportLimits.manifestReserveBytes,
  metadataLimitBytes = debugExportLimits.contextMetadataBytes } = {}) {
  captureMode ??= limitBytes === undefined ? 'complete' : 'bounded';
  if (!['complete', 'bounded'].includes(captureMode) || captureMode === 'complete' && limitBytes !== undefined)
    throw new Error('Choose complete capture without an optional context budget, or bounded capture.');
  const bounded = captureMode === 'bounded';
  if (limitBytes === undefined) limitBytes = debugExportLimits.contextBytes;
  if (![limitBytes, stageBytes, manifestReserveBytes, metadataLimitBytes].every(value => Number.isSafeInteger(value) && value >= 0)
      || limitBytes > debugExportLimits.contextBytes) throw new Error('Use a nonnegative optional context budget at or below 512 MiB.');
  let capturedBytes = 0, metadataBytes = 0, omittedFiles = 0, omittedSubtrees = 0, limited = false, omittedPathsComplete = true;
  return {
    captureMode,
    withinStageLimit: total => Number.isSafeInteger(total) && total >= 0 && (!bounded || total <= stageBytes),
    hasManifestHeadroom: total => !bounded || total <= stageBytes - manifestReserveBytes,
    remainingBytes: total => bounded ? Math.max(0, Math.min(limitBytes - capturedBytes, stageBytes - manifestReserveBytes - total)) : Infinity,
    reason(bytes, total) {
      if (!bounded) return null;
      if (metadataBytes >= metadataLimitBytes) return 'context_manifest_budget';
      if (bytes > limitBytes - capturedBytes) return 'context_byte_budget';
      if (bytes > stageBytes - manifestReserveBytes - total) return 'context_stage_headroom';
      return null;
    },
    metadata(cost) {
      if (bounded && cost > metadataLimitBytes - metadataBytes) { metadataBytes = metadataLimitBytes; return false; }
      metadataBytes += cost; return true;
    },
    reserveManifestBase(bytes) { manifestReserveBytes = Math.max(manifestReserveBytes, bytes + metadataLimitBytes + 4096); },
    capture(bytes) { capturedBytes += bytes; },
    omit({ subtree = false, unlisted = false } = {}) {
      limited = true;
      if (subtree) omittedSubtrees++; else omittedFiles++;
      if (subtree || unlisted) omittedPathsComplete = false;
    },
    unlisted() { limited = true; omittedPathsComplete = false; },
    snapshot() { return { captureMode, limitBytes: bounded ? limitBytes : null, capturedBytes,
      metadataLimitBytes: bounded ? metadataLimitBytes : null, metadataBytes, manifestReserveBytes: bounded ? manifestReserveBytes : null,
      omittedFiles, omittedSubtrees, omittedPathsComplete, limited }; },
  };
}
