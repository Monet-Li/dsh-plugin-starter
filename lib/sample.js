/**
 * 联网采样：构造查询 → 搜索 → 去重 → 统计 → 判级。
 * search 由外部注入（插件里是 ctx.web.search，测试里是假函数），因此本文件不依赖宿主。
 */

const TYPE_WORDS = {
  visual_style: '配色 风格 设计',
  copy_tone: '文案 语气 风格',
  tech_choice: '技术选型 推荐',
  product_tradeoff: '方案 取舍 实践',
  workflow: '工作流 实践',
  naming: '命名 习惯 规范',
  content_structure: '结构 组织 写法',
  lifestyle: '推荐 经验',
  other: '推荐 经验',
}

const FILLER = /^(帮我|请|我想|我要|能不能|可以|请问|麻烦|现在|最近|一下|看看)/

export function condense(question, maxLen = 26) {
  let s = String(question || '').replace(/```[\s\S]*?```/g, ' ')
  s = s.replace(FILLER, '')
  s = s.replace(/[？?。!！,，、；;：:"'“”()（）\[\]【】]/g, ' ')
  s = s.replace(/\s+/g, ' ').trim()
  return s.slice(0, maxLen).trim()
}

export function buildQueries({ question, problemType, tags = [], maxQueries = 3 } = {}) {
  const core = condense(question)
  if (!core) return []
  const typeWord = TYPE_WORDS[problemType] || TYPE_WORDS.other
  const situationWord = tags
    .map((t) => TAG_WORDS[t])
    .filter(Boolean)
    .slice(0, 2)
    .join(' ')
  const base = [core, situationWord, typeWord].filter(Boolean).join(' ')
  const queries = [base]
  if (maxQueries > 1) queries.push(`${base} 现在 流行`)
  if (maxQueries > 2) queries.push(`${core} ${typeWord} best practice`)
  return [...new Set(queries)].slice(0, maxQueries)
}

const TAG_WORDS = {
  platform_web: '网页',
  platform_mobile: '移动端',
  platform_desktop: '桌面',
  audience_b2b: 'B2B',
  audience_b2c: 'C 端',
  audience_developer: '开发者',
  context_personal: '个人项目',
  context_team: '团队',
  context_opensource: '开源',
  budget_low: '低成本',
  time_short: '快速',
  long_term: '长期维护',
  locale_zh: '中文',
  locale_en: '英文',
  brand_serious: '专业',
  brand_playful: '活泼',
}

const TRACKING_PARAMS = [
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'ref', 'ref_src', 'fbclid', 'gclid', 'spm', 'from', 'share_token',
]

export function canonicalUrl(url) {
  try {
    const u = new URL(String(url))
    u.hash = ''
    for (const key of [...u.searchParams.keys()]) {
      if (TRACKING_PARAMS.includes(key.toLowerCase()) || key.toLowerCase().startsWith('utm_')) {
        u.searchParams.delete(key)
      }
    }
    u.protocol = 'https:'
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, '')
    const path = u.pathname.replace(/\/+$/, '')
    const search = u.searchParams.toString()
    return `${u.hostname}${path}${search ? `?${search}` : ''}`
  } catch {
    return String(url || '')
  }
}

export function hostOf(url) {
  try {
    return new URL(String(url)).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return ''
  }
}

export function dedupeSources(list = []) {
  const seen = new Set()
  const out = []
  for (const item of list) {
    if (!item || !item.url) continue
    const key = canonicalUrl(item.url)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push({ ...item, key, host: hostOf(item.url) })
  }
  return out
}

export function computeStats(sources = []) {
  const sourceCount = sources.length
  const hosts = new Map()
  let dated = 0
  for (const s of sources) {
    const h = s.host || hostOf(s.url) || 'unknown'
    hosts.set(h, (hosts.get(h) || 0) + 1)
    if (s.publishedAt && Number.isFinite(Date.parse(s.publishedAt))) dated += 1
  }
  const domainCount = hosts.size
  const top = [...hosts.values()].sort((a, b) => b - a)[0] || 0
  return {
    sourceCount,
    domainCount,
    topDomainShare: sourceCount ? Number((top / sourceCount).toFixed(3)) : 0,
    datedShare: sourceCount ? Number((dated / sourceCount).toFixed(3)) : 0,
  }
}

export function gradeStrength(stats) {
  const { sourceCount, domainCount, topDomainShare, datedShare } = stats
  if (sourceCount >= 8 && domainCount >= 5 && topDomainShare <= 0.5 && datedShare >= 0.5) return 'strong'
  if (sourceCount >= 4 && domainCount >= 3 && topDomainShare <= 0.6) return 'weak'
  return 'none'
}

function withTimeout(promise, ms) {
  if (!Number.isFinite(ms) || ms <= 0) return promise
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const t = setTimeout(() => reject(new Error('sample_timeout')), ms)
      if (typeof t?.unref === 'function') t.unref()
    }),
  ])
}

/**
 * @param {object} p
 * @param {(req:{query:string,maxResults?:number}, signal?:AbortSignal) => Promise<any>} p.search
 */
export async function samplePreference({
  search,
  question,
  problemType = 'other',
  tags = [],
  maxResults = 10,
  maxQueries = 3,
  timeoutMs = 12000,
  normalize = (res) => res,
  now = new Date().toISOString(),
} = {}) {
  const queries = buildQueries({ question, problemType, tags, maxQueries })
  const base = { queries, question, problem_type: problemType, created_at: now }

  if (typeof search !== 'function') {
    return {
      ...base,
      strength: 'none',
      degraded: true,
      reason: 'provider_unavailable',
      stats: computeStats([]),
      sources: [],
      byDomain: {},
    }
  }
  if (!queries.length) {
    return {
      ...base,
      strength: 'none',
      degraded: true,
      reason: 'empty_question',
      stats: computeStats([]),
      sources: [],
      byDomain: {},
    }
  }

  const attempts = []
  for (const query of queries) {
    try {
      const raw = await withTimeout(Promise.resolve(search({ query, maxResults })), timeoutMs)
      const res = normalize(raw) || {}
      attempts.push({
        query,
        ok: true,
        sources: Array.isArray(res.sources) ? res.sources : [],
      })
    } catch (error) {
      attempts.push({ query, ok: false, sources: [], error: String(error?.message || error) })
    }
  }

  const okAttempts = attempts.filter((a) => a.ok)
  const merged = dedupeSources(okAttempts.flatMap((a) => a.sources))
  const stats = computeStats(merged)
  const byDomain = {}
  for (const s of merged) {
    const h = s.host || 'unknown'
    byDomain[h] = (byDomain[h] || 0) + 1
  }

  const allFailed = attempts.every((a) => !a.ok)
  const noHits = merged.length === 0
  let strength = allFailed || noHits ? 'none' : gradeStrength(stats)
  let reason = 'ok'

  if (allFailed) {
    reason = classifySearchFailure(attempts)
  } else if (noHits) {
    reason = 'no_results'
  } else if (stats.domainCount <= 1 && merged.length > 1) {
    strength = 'none'
    reason = 'single_domain'
  } else if (okAttempts.length < attempts.length) {
    reason = 'partial_failure'
  }

  return {
    ...base,
    strength,
    degraded: strength === 'none',
    reason,
    error: attempts.find((a) => a.error)?.error,
    stats,
    byDomain,
    sources: merged.slice(0, maxResults * 2),
    attempts: attempts.map(({ query, ok, error }) => ({ query, ok, error })),
  }
}

/**
 * 把 web 服务的 WebError 归一成可读原因：不能把「provider 没配好」和「网络抖了一下」混成一句话。
 * 真实项目里的消息形如 `configured web provider "x" is registered but unavailable`。
 */
function classifySearchFailure(attempts) {
  const text = attempts.map((a) => a.error || '').join(' ')
  if (/AMBIGUOUS/i.test(text)) return 'provider_ambiguous'
  if (/UNAVAILABLE|unavailable|not configured|missing/i.test(text)) return 'provider_unavailable'
  return 'search_failed'
}

/**
 * 校验模型给的方向：不超过 3 个；有来源的方向必须挂真实 URL，且至少两个不同域名；
 * 挂不上来源的方向必须自己声明是推导的。
 */
export function validateDirections(directions = [], sources = [], { maxDirections = 3 } = {}) {
  const problems = []
  const byKey = new Map(sources.map((s) => [canonicalUrl(s.url), s]))
  const list = Array.isArray(directions) ? directions : []

  if (list.length === 0) problems.push('no_directions')
  if (list.length > maxDirections) problems.push(`too_many_directions:${list.length}`)

  const checked = list.map((d, index) => {
    const name = String(d?.name || '').trim()
    const urls = Array.isArray(d?.sources) ? d.sources : []
    const hosts = new Set()
    let verified = 0
    for (const u of urls) {
      const hit = byKey.get(canonicalUrl(u))
      if (hit) {
        verified += 1
        hosts.add(hit.host || hostOf(u))
      }
    }
    const derived = Boolean(d?.derived)
    if (!name) problems.push(`missing_name:${index}`)
    if (urls.length > 0 && verified === 0) problems.push(`unverified_sources:${name || index}`)
    if (verified > 0 && hosts.size < 2) problems.push(`single_domain_evidence:${name || index}`)
    if (verified === 0 && !derived) problems.push(`evidence_or_derived_required:${name || index}`)
    if (!derived && verified === 0) problems.push(`fabricated_evidence_risk:${name || index}`)
    return { ...d, name, verifiedSources: verified, hostCount: hosts.size, derived }
  })

  return { ok: problems.length === 0, problems, directions: checked }
}
