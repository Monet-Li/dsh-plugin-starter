import test from 'node:test'
import assert from 'node:assert/strict'
import {
  canonicalUrl,
  dedupeSources,
  computeStats,
  gradeStrength,
  buildQueries,
  samplePreference,
  extractPublishedAt,
  harvestPublishedDates,
  validateDirections,
} from '../lib/sample.js'

function src(host, n = 1, { dated = true } = {}) {
  return {
    url: `https://${host}/post-${n}?utm_source=x`,
    title: `${host} ${n}`,
    snippet: 's',
    publishedAt: dated ? '2026-10-01T00:00:00Z' : null,
  }
}

function spread(count, domains) {
  const out = []
  for (let i = 0; i < count; i += 1) out.push(src(domains[i % domains.length], i))
  return out
}

test('URL 规范化：去 utm、去 www、去尾斜杠、强制 https', () => {
  assert.equal(canonicalUrl('http://www.Example.com/a/b/?utm_source=x&id=3#frag'), 'example.com/a/b?id=3')
  assert.equal(canonicalUrl('https://example.com/'), 'example.com')
})

test('去重按规范化 URL', () => {
  const list = dedupeSources([
    { url: 'https://a.com/x?utm_medium=y' },
    { url: 'http://www.a.com/x/' },
    { url: 'https://b.com/x' },
  ])
  assert.equal(list.length, 2)
  assert.equal(list[0].host, 'a.com')
})

test('统计与判级', () => {
  const sources = dedupeSources(spread(9, ['a.com', 'b.com', 'c.com', 'd.com', 'e.com', 'f.com']))
  const stats = computeStats(sources)
  assert.equal(stats.sourceCount, 9)
  assert.equal(stats.domainCount, 6)
  assert.ok(stats.topDomainShare <= 0.5)
  assert.equal(stats.datedShare, 1)
  assert.equal(gradeStrength(stats), 'strong')

  assert.equal(gradeStrength(computeStats(dedupeSources(spread(4, ['a.com', 'b.com', 'c.com'])))), 'weak')
  assert.equal(gradeStrength(computeStats(dedupeSources(spread(2, ['a.com', 'b.com'])))), 'none')
})

test('查询构造包含核心词与情境词', () => {
  const q = buildQueries({ question: '帮我选落地页配色', problemType: 'visual_style', tags: ['platform_web'] })
  assert.ok(q.length >= 1 && q.length <= 3)
  assert.match(q[0], /落地页配色/)
  assert.match(q[0], /网页/)
})

test('采样成功 → strong，并给出域名分布', async () => {
  const search = async () => ({ sources: spread(9, ['a.com', 'b.com', 'c.com', 'd.com', 'e.com', 'f.com']) })
  const r = await samplePreference({ search, question: '帮我选落地页配色', problemType: 'visual_style', tags: ['platform_web'] })
  assert.equal(r.strength, 'strong')
  assert.equal(r.degraded, false)
  assert.equal(r.reason, 'ok')
  assert.equal(Object.keys(r.byDomain).length, 6)
  assert.ok(r.sources.length > 0)
})

test('搜索抛错 → 兜底为 none，不编造', async () => {
  const search = async () => {
    throw new Error('network down')
  }
  const r = await samplePreference({ search, question: '帮我选落地页配色', problemType: 'visual_style' })
  assert.equal(r.strength, 'none')
  assert.equal(r.degraded, true)
  assert.equal(r.reason, 'search_failed')
  assert.equal(r.sources.length, 0)
  assert.equal(r.stats.sourceCount, 0)
})

test('没有搜索能力 → provider_unavailable', async () => {
  const r = await samplePreference({ search: undefined, question: '帮我选配色' })
  assert.equal(r.strength, 'none')
  assert.equal(r.reason, 'provider_unavailable')
})

test('provider 已注册但不可用 → provider_unavailable，且保留原始错误', async () => {
  const search = async () => {
    throw new Error('configured web provider "web-search-free" is registered but unavailable')
  }
  const r = await samplePreference({ search, question: '帮我选配色' })
  assert.equal(r.strength, 'none')
  assert.equal(r.reason, 'provider_unavailable')
  assert.match(r.error, /registered but unavailable/)
})

test('多 provider 歧义 → provider_ambiguous', async () => {
  const search = async () => {
    throw new Error('WEB_PROVIDER_AMBIGUOUS: multiple usable providers')
  }
  const r = await samplePreference({ search, question: '帮我选配色' })
  assert.equal(r.strength, 'none')
  assert.equal(r.reason, 'provider_ambiguous')
})

test('搜到 0 条 → no_results', async () => {
  const r = await samplePreference({ search: async () => ({ sources: [] }), question: '帮我选配色' })
  assert.equal(r.strength, 'none')
  assert.equal(r.reason, 'no_results')
})

test('结果全来自一个站 → 不算共识', async () => {
  const search = async () => ({ sources: spread(9, ['only.com']) })
  const r = await samplePreference({ search, question: '帮我选配色', problemType: 'visual_style' })
  assert.equal(r.strength, 'none')
  assert.equal(r.reason, 'single_domain')
})

test('部分查询失败仍可用，但标明 partial', async () => {
  let call = 0
  const search = async () => {
    call += 1
    if (call === 1) throw new Error('boom')
    return { sources: spread(9, ['a.com', 'b.com', 'c.com', 'd.com', 'e.com', 'f.com']) }
  }
  const r = await samplePreference({ search, question: '帮我选配色', problemType: 'visual_style' })
  assert.equal(r.strength, 'strong')
  assert.equal(r.reason, 'partial_failure')
})

test('方向校验：超过 3 个 / 来源对不上 / 单域名 / 未标推导 都要报', () => {
  const sources = dedupeSources([src('a.com', 1), src('b.com', 2)])
  const bad = validateDirections(
    [
      { name: 'A', sources: ['https://a.com/post-1'] },
      { name: 'B', sources: ['https://fake.com/x'] },
      { name: 'C' },
      { name: 'D', derived: true },
    ],
    sources,
    { maxDirections: 3 },
  )
  assert.equal(bad.ok, false)
  assert.ok(bad.problems.some((p) => p.startsWith('too_many_directions')))
  assert.ok(bad.problems.some((p) => p.startsWith('single_domain_evidence')))
  assert.ok(bad.problems.some((p) => p.startsWith('unverified_sources')))
  assert.ok(bad.problems.some((p) => p.startsWith('evidence_or_derived_required')))
})

test('方向校验：来源合法且标了推导可通过', () => {
  const sources = dedupeSources([src('a.com', 1), src('b.com', 2)])
  const ok = validateDirections(
    [
      { name: 'A', sources: ['https://a.com/post-1', 'https://b.com/post-2'] },
      { name: 'B', derived: true },
    ],
    sources,
  )
  assert.equal(ok.ok, true, ok.problems.join(','))
  assert.equal(ok.directions[0].verifiedSources, 2)
  assert.equal(ok.directions[0].hostCount, 2)
})

// ── 发布日期回采：provider 不给 publishedAt，由插件自己从页面里抽 ─────────────────

const metaPage = (v) => `<html><head><meta property="article:published_time" content="${v}"></head><body>x</body></html>`
const attrSwappedPage = (v) => `<html><head><meta content="${v}" name="pubdate"></head></html>`
const jsonLdPage = (v) => `<html><head><script type="application/ld+json">{"@type":"Article","datePublished":"${v}"}</script></head></html>`
const timePage = (v) => `<html><body><article><time datetime="${v}">x</time></article></body></html>`

test('抽日期：meta / 属性顺序颠倒 / JSON-LD / <time datetime> 都要认', () => {
  assert.equal(extractPublishedAt(metaPage('2026-03-05T08:00:00Z')), '2026-03-05')
  assert.equal(extractPublishedAt(attrSwappedPage('2025-12-31')), '2025-12-31')
  assert.equal(extractPublishedAt(jsonLdPage('2024-07-09T00:00:00+08:00')), '2024-07-08')
  assert.equal(extractPublishedAt(timePage('2026-01-02T00:00:00Z')), '2026-01-02')
})

test('抽日期：没有日期、只有更新时间、日期非法、年份离谱，一律返回 null', () => {
  assert.equal(extractPublishedAt('<html><body>no date here</body></html>'), null)
  assert.equal(
    extractPublishedAt('<html><head><meta property="article:modified_time" content="2026-01-01"></head></html>'),
    null,
  )
  assert.equal(extractPublishedAt(metaPage('not-a-date')), null)
  assert.equal(extractPublishedAt(metaPage('3/5')), null)
  assert.equal(extractPublishedAt(metaPage('2099-01-01')), null)
  assert.equal(extractPublishedAt(metaPage('1980-01-01')), null)
  assert.equal(extractPublishedAt(''), null)
  assert.equal(extractPublishedAt(undefined), null)
})

test('回采：成功填日期、抓取抛错与非 2xx 计为失败，未抓的不算尝试', async () => {
  const sources = dedupeSources([src('a.com', 1, { dated: false }), src('b.com', 2, { dated: false }), src('c.com', 3, { dated: false })])
  const calls = []
  const fetched = async ({ url }) => {
    calls.push(url)
    if (url.includes('b.com')) throw new Error('boom')
    if (url.includes('c.com')) return { statusCode: 404, body: { kind: 'text', content: 'nope' } }
    return { statusCode: 200, body: { kind: 'html', content: metaPage('2026-02-01') } }
  }
  const { sources: out, summary } = await harvestPublishedDates(sources, { fetch: fetched, maxFetch: 5 })
  assert.equal(summary.attempted, 3)
  assert.equal(summary.filled, 1)
  assert.equal(summary.failed, 2)
  assert.equal(out[0].publishedAt, '2026-02-01')
  assert.ok(!out[1].publishedAt)
  assert.equal(calls.length, 3)
})

test('回采：没有 fetch 时整体降级为 skipped，不抛错', async () => {
  const sources = dedupeSources([src('a.com', 1, { dated: false })])
  const { sources: out, summary } = await harvestPublishedDates(sources, {})
  assert.equal(summary.disabled, true)
  assert.equal(summary.attempted, 0)
  assert.ok(!out[0].publishedAt)
})

test('端到端：搜索无日期 → 回采补上 → strength 从 weak 升到 strong', async () => {
  const raw = Array.from({ length: 8 }, (_, i) =>
    src(['a.com', 'b.com', 'c.com', 'd.com', 'e.com', 'f.com'][i % 6], i, { dated: false }),
  )
  const search = async () => ({ sources: raw, truncated: false })
  const fetchPage = async () => ({ statusCode: 200, body: { kind: 'html', content: metaPage('2026-02-01') } })

  const before = await samplePreference({ search, question: '个人博客配色用什么', problemType: 'visual_style' })
  assert.equal(before.strength, 'weak')
  assert.equal(before.stats.datedShare, 0)

  const after = await samplePreference({
    search,
    fetch: fetchPage,
    question: '个人博客配色用什么',
    problemType: 'visual_style',
    dateProbeMax: 8,
  })
  assert.equal(after.stats.datedShare, 1)
  assert.equal(after.strength, 'strong')
  assert.equal(after.dateProbe.filled, 8)
})

test('端到端：dateProbe=false 时一个页面都不抓', async () => {
  let touched = 0
  const search = async () => ({ sources: [src('a.com', 1, { dated: false })], truncated: false })
  const fetchPage = async () => {
    touched += 1
    return { statusCode: 200, body: { kind: 'html', content: metaPage('2026-02-01') } }
  }
  const res = await samplePreference({
    search,
    fetch: fetchPage,
    question: 'x',
    problemType: 'other',
    dateProbe: false,
  })
  assert.equal(touched, 0)
  assert.equal(res.dateProbe.disabled, true)
})
