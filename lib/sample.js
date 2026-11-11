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

/**
 * 只有这些 meta 键代表「作品什么时候发布的」。刻意不接收 `article:modified_time` /
 * `og:updated_time`：更新时间不是发布时间，拿它凑时效等于把旧文章当成新文章。
 */
const PUBLISHED_META_KEYS = new Set([
  'article:published_time',
  'og:article:published_time',
  'datepublished',
  'date',
  'pubdate',
  'publishdate',
  'publish_date',
  'publish-date',
  'dc.date.issued',
  'dc.date',
  'sailthru.date',
  'parsely-pub-date',
  'article.published',
])

const MIN_YEAR = 1990

/**
 * 从一份 HTML 里抽真实发布时间。三类证据按可信度排序：meta → JSON-LD → <time datetime>。
 * 只接受能解析、且年份落在合理区间的值；抽不到就返回 null，绝不猜。
 * @param {string} html
 * @param {{now?:number}} [opts]
 * @returns {string|null} `YYYY-MM-DD`
 */
export function extractPublishedAt(html, { now = Date.now() } = {}) {
  if (typeof html !== 'string' || html.length === 0) return null
  // 头部 300KB 足够覆盖 <head> 与开头的 JSON-LD；再往后是正文，只会拖慢正则
  const head = html.length > 300_000 ? html.slice(0, 300_000) : html

  const candidates = []

  const metaRe = /<meta\b[^>]*>/gi
  const tagAttr = (tag, keys) => {
    for (const key of keys) {
      const m = tag.match(new RegExp(`\\b${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i'))
      if (m) return (m[1] ?? m[2] ?? m[3] ?? '').trim()
    }
    return ''
  }
  for (const tag of head.match(metaRe) || []) {
    const key = (tagAttr(tag, ['property', 'name', 'itemprop']) || '').toLowerCase()
    if (!key || !PUBLISHED_META_KEYS.has(key)) continue
    const content = tagAttr(tag, ['content', 'value'])
    if (content) candidates.push(content)
  }

  const jsonLdRe = /"datePublished"\s*:\s*"([^"]{4,60})"/gi
  for (const m of head.matchAll(jsonLdRe)) candidates.push(m[1])

  const timeRe = /<time\b[^>]*\bdatetime\s*=\s*(?:"([^"]+)"|'([^']+)')/gi
  for (const m of head.matchAll(timeRe)) candidates.push(m[1] ?? m[2])

  for (const raw of candidates) {
    const iso = normalizeDate(raw, now)
    if (iso) return iso
  }
  return null
}

/** 把各种写法（ISO / RFC 822 / `2024/03/05` / 纯 `2024-03-05`）变成 `YYYY-MM-DD`，不合理就丢弃。 */
function normalizeDate(raw, now) {
  const text = String(raw || '').trim()
  if (!text || text.length > 60) return null
  // 只接受带年份的写法，避免 "3/5" 这种被 Date.parse 按当年补全的猜测
  if (!/\d{4}/.test(text)) return null
  const ms = Date.parse(text)
  if (!Number.isFinite(ms)) return null
  const year = new Date(ms).getUTCFullYear()
  const nowYear = new Date(now).getUTCFullYear()
  if (year < MIN_YEAR || year > nowYear + 1) return null
  return new Date(ms).toISOString().slice(0, 10)
}

/**
 * 搜索结果普遍不带 `publishedAt`（deepseek-official 与 web-search-free 都是如此），
 * 所以由插件自己抓前 N 条页面补日期。抓不到就留空——判级会如实落到 weak。
 *
 * @param {Array<object>} sources 已去重（带 key）的来源
 * @param {{fetch?:Function, maxFetch?:number, timeoutMs?:number, concurrency?:number}} opts
 */
export async function harvestPublishedDates(
  sources = [],
  { fetch, maxFetch = 6, timeoutMs = 4000, concurrency = 3, now = Date.now() } = {},
) {
  const out = sources.map((s) => ({ ...s }))
  const summary = { attempted: 0, filled: 0, failed: 0, skipped: 0, disabled: false }
  if (typeof fetch !== 'function') {
    summary.disabled = true
    summary.skipped = out.length
    return { sources: out, summary }
  }
  if (!Number.isFinite(maxFetch) || maxFetch <= 0) {
    summary.disabled = true
    summary.skipped = out.length
    return { sources: out, summary }
  }

  const targets = out.filter((s) => s.url && !s.publishedAt).slice(0, maxFetch)
  summary.skipped = out.length - targets.length
  if (targets.length === 0) return { sources: out, summary }

  const queue = targets.slice()
  const worker = async () => {
    for (;;) {
      const item = queue.shift()
      if (!item) return
      summary.attempted += 1
      try {
        const result = await withTimeout(Promise.resolve(fetch({ url: item.url })), timeoutMs)
        if (Number(result?.statusCode) >= 400) {
          summary.failed += 1
          continue
        }
        const body = result?.body
        const html = typeof body === 'string' ? body : body?.content || ''
        const iso = extractPublishedAt(html, { now })
        if (iso) {
          item.publishedAt = iso
          summary.filled += 1
        } else {
          summary.failed += 1
        }
      } catch {
        summary.failed += 1
      }
    }
  }
  const width = Math.max(1, Math.min(concurrency, targets.length))
  await Promise.all(Array.from({ length: width }, worker))
  return { sources: out, summary }
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
  fetch,
  question,
  problemType = 'other',
  tags = [],
  maxResults = 10,
  maxQueries = 3,
  timeoutMs = 12000,
  dateProbe = true,
  dateProbeMax = 6,
  dateProbeTimeoutMs = 4000,
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
  const deduped = dedupeSources(okAttempts.flatMap((a) => a.sources))

  // 搜索 provider 基本都不给 publishedAt，所以这里自己补；补不到就保持空，判级会落到 weak。
  const harvested =
    dateProbe && deduped.length
      ? await harvestPublishedDates(deduped, {
          fetch,
          maxFetch: dateProbeMax,
          timeoutMs: dateProbeTimeoutMs,
          now: Date.parse(now) || Date.now(),
        })
      : { sources: deduped, summary: { attempted: 0, filled: 0, failed: 0, skipped: deduped.length, disabled: true } }

  const merged = harvested.sources
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
    dateProbe: harvested.summary,
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
