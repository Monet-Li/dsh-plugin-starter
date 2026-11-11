import test from 'node:test'
import assert from 'node:assert/strict'
import { openStore } from '../lib/store.js'
import { buildTools } from '../lib/tools.js'
import { normalizeConfig } from '../lib/config.js'
import { detectIntent } from '../lib/classify.js'
import { auditAnswer } from '../lib/prompts.js'

function fakeSources(count = 9, domains = ['a.com', 'b.com', 'c.com', 'd.com', 'e.com', 'f.com']) {
  const out = []
  for (let i = 0; i < count; i += 1) {
    const host = domains[i % domains.length]
    out.push({
      url: `https://${host}/p/${i}`,
      title: `${host} 第 ${i} 篇`,
      snippet: '做法说明',
      publishedAt: '2026-10-01',
    })
  }
  return out
}

function makeCtx({ search } = {}) {
  const store = openStore(':memory:')
  const cfg = normalizeConfig({ dbPath: ':memory:' })
  const tools = buildTools({ store, search, cfg })
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]))
  return { store, cfg, byName }
}

test('验收①：主观问题 → 采样出 sources，能凑出 2~3 个方向', async () => {
  const { byName, store } = makeCtx({ search: async () => ({ sources: fakeSources() }) })
  assert.equal(detectIntent('帮我选落地页配色').verdict, 'yes')

  const sampled = await byName.pref_sample.execute({
    question: '帮我选落地页配色',
    problem_type: 'visual_style',
    situation_tags: ['platform_web'],
  })
  assert.equal(sampled.strength, 'strong')
  assert.ok(sampled.sources.length >= 6)
  assert.ok(sampled.run_id)
  assert.equal(sampled.rules.max_directions, 3)
  assert.equal(sampled.rules.require_2_domains_per_direction, true)

  const rows = store.raw.prepare('SELECT * FROM sampling_runs').all()
  assert.equal(rows.length, 1)
  store.close()
})

test('验收②：客观问题不触发（分类层就否掉）', () => {
  const r = detectIntent('这段代码为什么报错：TypeError: undefined is not a function')
  assert.equal(r.verdict, 'no')
})

test('验收③④：选 A 后记录完整，第二次能读到偏好', async () => {
  const { byName, store } = makeCtx({ search: async () => ({ sources: fakeSources() }) })

  const before = await byName.pref_lookup.execute({ problem_type: 'visual_style', situation_tags: ['platform_web'] })
  assert.equal(before.found, false)

  const recorded = await byName.pref_record.execute({
    question: '帮我选落地页配色',
    problem_type: 'visual_style',
    situation_tags: ['platform_web', 'audience_b2b'],
    chosen_name: '冷色专业',
    chosen_description: '深蓝主色 + 大留白',
    reason: '客户是 B 端，不能太花',
    sampling_strength: 'strong',
    sampling_run_id: 'run-1',
  })
  assert.equal(recorded.recorded, true)
  assert.equal(recorded.level, 'weak')
  assert.equal(recorded.scope, 'situation')

  const row = store.raw.prepare('SELECT * FROM observations').get()
  assert.equal(row.question, '帮我选落地页配色')
  assert.equal(row.user_choice_name, '冷色专业')
  assert.equal(row.user_reason, '客户是 B 端，不能太花')
  assert.equal(row.situation_bucket, 'audience_b2b|platform_web')
  assert.equal(row.level_after, 'weak')

  const after = await byName.pref_lookup.execute({ problem_type: 'visual_style', situation_tags: ['platform_web'] })
  assert.equal(after.found, true)
  assert.equal(after.direction.name, '冷色专业')
  assert.match(after.advice, /按你上次的偏好/)
  store.close()
})

test('同方向第三次 → global，并给出跨情境提示', async () => {
  const { byName } = makeCtx({ search: async () => ({ sources: fakeSources() }) })
  const base = {
    question: '帮我选落地页配色',
    problem_type: 'visual_style',
    situation_tags: ['platform_web'],
    chosen_name: '冷色专业',
  }
  const r1 = await byName.pref_record.execute(base)
  const r2 = await byName.pref_record.execute(base)
  const r3 = await byName.pref_record.execute(base)
  assert.equal(r1.level, 'weak')
  assert.equal(r2.level, 'strong')
  assert.equal(r3.level, 'global')
  assert.match(r3.hint, /跨情境偏好/)
})

test('改选别的方向 → 记录里带降级来源', async () => {
  const { byName } = makeCtx({ search: async () => ({ sources: fakeSources() }) })
  const base = { question: '帮我选落地页配色', problem_type: 'visual_style', situation_tags: ['platform_web'] }
  await byName.pref_record.execute({ ...base, chosen_name: '冷色专业' })
  await byName.pref_record.execute({ ...base, chosen_name: '冷色专业' })
  const other = await byName.pref_record.execute({ ...base, chosen_name: '暖色活泼' })
  assert.equal(other.level, 'weak')
  assert.equal(other.downgraded_from.name, '冷色专业')
  assert.equal(other.downgraded_from.level, 'strong')
})

test('验收⑤：没有搜索能力 → 明确「缺乏共识」，不编造', async () => {
  const { byName } = makeCtx({ search: undefined })
  const sampled = await byName.pref_sample.execute({
    question: '帮我选落地页配色',
    problem_type: 'visual_style',
    situation_tags: ['platform_web'],
  })
  assert.equal(sampled.strength, 'none')
  assert.equal(sampled.degraded, true)
  assert.match(sampled.caveat, /没有找到可靠共识/)
})

test('采样失败兜底：搜索抛错也返回 none 而不是抛给模型', async () => {
  const { byName } = makeCtx({
    search: async () => {
      throw new Error('offline')
    },
  })
  const sampled = await byName.pref_sample.execute({
    question: '帮我选落地页配色',
    problem_type: 'visual_style',
    situation_tags: ['platform_web'],
  })
  assert.equal(sampled.strength, 'none')
  assert.equal(sampled.reason, 'search_failed')
})

test('记录时校验方向来源，编造的会被标出来', async () => {
  const { byName } = makeCtx({ search: async () => ({ sources: fakeSources() }) })
  const r = await byName.pref_record.execute({
    question: '帮我选落地页配色',
    problem_type: 'visual_style',
    situation_tags: ['platform_web'],
    chosen_name: '冷色专业',
    directions: [
      { name: '冷色专业', sources: ['https://not-in-sample.com/x'] },
      { name: '无依据方向' },
    ],
  })
  assert.equal(r.recorded, true)
  assert.ok(r.audit.length >= 1)
})

test('提示词自检：无来源时不许说「主流」', () => {
  assert.equal(auditAnswer('这是主流做法').ok, false)
  assert.equal(auditAnswer('这是主流做法', { hasSources: true }).ok, true)
  assert.equal(auditAnswer('样本有限，只作参考').ok, true)
})

test('工具定义齐全且 schema 是合法对象', () => {
  const { byName } = makeCtx({ search: async () => ({ sources: [] }) })
  for (const name of ['pref_lookup', 'pref_sample', 'pref_record']) {
    const def = byName[name]
    assert.ok(def, `${name} 缺失`)
    assert.equal(typeof def.description, 'string')
    assert.equal(def.parameters.type, 'object')
    assert.ok(Array.isArray(def.parameters.required))
    assert.equal(typeof def.execute, 'function')
    assert.equal(typeof def.output.render, 'function')
    const blocks = def.output.render({}, { found: true, advice: 'x', stats: {} })
    assert.equal(blocks[0].type, 'text')
  }
})
