export const debugExportLimits = Object.freeze({
  stageBytes: 4 * 1024 ** 3, contextBytes: 512 * 1024 ** 2,
  manifestReserveBytes: 8 * 1024 ** 2, contextMetadataBytes: 4 * 1024 ** 2,
});

// The mandatory streams own the stage budget. Optional files may only consume
// its remaining space after preserving room for their final manifest.
export function createDebugContextBudget({ limitBytes = debugExportLimits.contextBytes,
  stageBytes = debugExportLimits.stageBytes, manifestReserveBytes = debugExportLimits.manifestReserveBytes,
  metadataLimitBytes = debugExportLimits.contextMetadataBytes } = {}) {
  if (![limitBytes, stageBytes, manifestReserveBytes, metadataLimitBytes].every(value => Number.isSafeInteger(value) && value >= 0)
      || limitBytes > debugExportLimits.contextBytes) throw new Error('Use a nonnegative optional context budget at or below 512 MiB.');
  let capturedBytes = 0, metadataBytes = 0, omittedFiles = 0, omittedSubtrees = 0, limited = false, omittedPathsComplete = true;
  return {
    hasManifestHeadroom: total => total <= stageBytes - manifestReserveBytes,
    remainingBytes: total => Math.max(0, Math.min(limitBytes - capturedBytes, stageBytes - manifestReserveBytes - total)),
    reason(bytes, total) {
      if (metadataBytes >= metadataLimitBytes) return 'context_manifest_budget';
      if (bytes > limitBytes - capturedBytes) return 'context_byte_budget';
      if (bytes > stageBytes - manifestReserveBytes - total) return 'context_stage_headroom';
      return null;
    },
    metadata(cost) {
      if (cost > metadataLimitBytes - metadataBytes) { metadataBytes = metadataLimitBytes; return false; }
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
    snapshot() { return { limitBytes, capturedBytes, metadataLimitBytes, metadataBytes, manifestReserveBytes,
      omittedFiles, omittedSubtrees, omittedPathsComplete, limited }; },
  };
}
