export function computeConfidence({
  strength = 'none',
  domainCount = 0,
  ageDays = 0,
  staleDays = 90,
  grounded = false,
  explicitGlobal = false,
} = {}) {
  const evidence = strength === 'strong' ? 1 : strength === 'weak' ? 0.6 : 0.2
  const recency = Math.max(0, Math.min(1, 1 - ageDays / Math.max(1, staleDays)))
  const diversity = Math.max(0, Math.min(1, domainCount / 5))
  const grounding = grounded ? 1 : 0.5
  const value =
    0.4 * evidence +
    0.2 * recency +
    0.15 * diversity +
    0.25 * grounding +
    (explicitGlobal ? 0.15 : 0)
  return Number(Math.min(1, value).toFixed(2))
}
