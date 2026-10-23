export function diagnosticError(error, limit = 800) {
  let message = String(error?.message || error).replace(/\bBearer\s+\S+|\b(?:sk-|eyJ)[A-Za-z0-9_.-]+/gi, '[redacted]');
  for (const [key, value] of Object.entries(process.env)) {
    if (/KEY|TOKEN|SECRET|PASSWORD/.test(key) && value?.length >= 6) message = message.replaceAll(value, '[redacted]');
  }
  return message.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, limit);
}
