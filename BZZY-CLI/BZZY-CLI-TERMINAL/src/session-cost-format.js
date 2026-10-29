export { deepseekSpendingVisible } from '@bzzy/core/engine/session-cost.js';

const usd = value => value === 0 ? '$0.0000' : value > 0 && value < 0.0001 ? '<$0.0001' : '$' + value.toFixed(4);
export function costLabel(value) {
  if (!value || !Number.isFinite(value.min) || !Number.isFinite(value.max) || value.min < 0 || value.max < value.min) return '—';
  const min = usd(value.min), max = usd(value.max);
  return min === max ? min : `${min}–${max}`;
}
export function sessionCostLines(spending, width) {
  if (!spending) return ['DeepSeek session estimate · waiting for usage'];
  const parts = [`Chat ≈ ${costLabel(spending.chat?.estimatedUsd)}`, `Compactor ≈ ${costLabel(spending.compactor?.estimatedUsd)}`, `Total ≈ ${costLabel(spending.total?.estimatedUsd)}`];
  const line = `${parts[0]} | ${parts[1]} = ${parts[2]}`;
  const rows = line.length <= width ? [line] : parts;
  if (!spending.total?.complete) rows.push(spending.bounded ? 'Partial estimate · linked-session limit reached' : 'Partial estimate · some usage is pending or unpriced');
  return rows;
}
