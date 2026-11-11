export const DEFAULT_CONFIG = {
  /** auto: 工具常开，模型自行判断何时用；manual: 需模型显式调用才记录；off: 不注册任何东西 */
  mode: 'auto',
  /** 空字符串 = <DSH_HOME>/plugin-data/dsh-self-taught/prefs.db */
  dbPath: '',
  maxDirections: 3,
  sampleMaxResults: 10,
  /** 搜索结果不带发布日期时，是否由插件自己抓页面补日期（strong 档依赖它） */
  dateProbe: true,
  /** 每次采样最多补几条页面的日期 */
  dateProbeMax: 6,
  /** 单条页面抓取超时 */
  dateProbeTimeoutMs: 4000,
  /** 偏好多久不看就不算强偏好 */
  staleDays: 90,
  /** 反例窗口：这么多天内出现相反选择，则允许「可例外」 */
  exceptionWindowDays: 30,
  debug: false,
}

export function normalizeConfig(input) {
  const raw = input && typeof input === 'object' ? input : {}
  const merged = { ...DEFAULT_CONFIG }
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined || v === null) continue
    merged[k] = v
  }
  if (!['auto', 'manual', 'off'].includes(merged.mode)) merged.mode = 'auto'
  merged.maxDirections = clampInt(merged.maxDirections, 1, 3, 3)
  merged.sampleMaxResults = clampInt(merged.sampleMaxResults, 3, 20, 10)
  merged.dateProbeMax = clampInt(merged.dateProbeMax, 0, 12, 6)
  merged.dateProbeTimeoutMs = clampInt(merged.dateProbeTimeoutMs, 500, 20000, 4000)
  merged.staleDays = clampInt(merged.staleDays, 1, 3650, 90)
  merged.exceptionWindowDays = clampInt(merged.exceptionWindowDays, 1, 3650, 30)
  return merged
}

function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

export function resolveDbPath(cfg, env = process.env) {
  if (cfg.dbPath) return cfg.dbPath
  const home = env.DSH_HOME || env.HOME || '.'
  return `${home.replace(/[\\/]+$/, '')}/plugin-data/dsh-self-taught/prefs.db`
}
