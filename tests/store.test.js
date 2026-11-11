import test from 'node:test'
import assert from 'node:assert/strict'
import { openStore } from '../lib/store.js'

function fresh() {
  const store = openStore(':memory:')
  return store
}

test('建库 + 写入 + 读回完整记录', () => {
  const store = fresh()
  const { id } = store.addObservation({
    question: '帮我选落地页配色',
    problem_type: 'visual_style',
    situation_tags: ['platform_web', 'audience_b2b'],
    situation_bucket: 'audience_b2b|platform_web',
    user_choice: '冷色专业',
    user_choice_name: '冷色专业',
    user_choice_description: '深蓝 + 留白',
    user_reason: '客户是 B 端，要显得可靠',
    level_after: 'weak',
    scope_after: 'situation',
    same_direction_count: 1,
  })
  assert.ok(id)
  assert.equal(store.count(), 1)

  const rows = store.historyFor('visual_style')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].question, '帮我选落地页配色')
  assert.deepEqual(rows[0].situation_tags, ['platform_web', 'audience_b2b'])
  assert.equal(rows[0].user_reason, '客户是 B 端，要显得可靠')
  assert.equal(rows[0].explicit_global, false)
  store.close()
})

test('historyFor 按类型隔离且升序', () => {
  const store = fresh()
  store.addObservation({ question: 'q1', problem_type: 'naming', user_choice_name: 'A', created_at: '2026-01-02T00:00:00Z' })
  store.addObservation({ question: 'q2', problem_type: 'naming', user_choice_name: 'B', created_at: '2026-01-01T00:00:00Z' })
  store.addObservation({ question: 'q3', problem_type: 'copy_tone', user_choice_name: 'C' })
  const rows = store.historyFor('naming')
  assert.deepEqual(rows.map((r) => r.user_choice_name), ['B', 'A'])
  assert.equal(store.historyFor('copy_tone').length, 1)
  store.close()
})

test('采样记录可审计', () => {
  const store = fresh()
  const { id } = store.addSamplingRun({
    question: '帮我选配色',
    problem_type: 'visual_style',
    queries: ['落地页配色 推荐'],
    source_count: 9,
    domain_count: 6,
    top_domain_share: 0.22,
    dated_share: 1,
    strength: 'strong',
    sources: [{ url: 'https://a.com/x' }],
  })
  const row = store.raw.prepare('SELECT * FROM sampling_runs WHERE id = ?').get(id)
  assert.equal(row.strength, 'strong')
  assert.deepEqual(JSON.parse(row.queries), ['落地页配色 推荐'])
  store.close()
})

test('偏好表 upsert 幂等', () => {
  const store = fresh()
  const p = {
    problem_type: 'visual_style',
    situation_bucket: 'general',
    direction_name: '冷色专业',
    level: 'weak',
    scope: 'situation',
    same_direction_count: 1,
    distinct_buckets: 1,
  }
  store.upsertPreference(p)
  store.upsertPreference({ ...p, level: 'strong', same_direction_count: 2 })
  const rows = store.raw.prepare('SELECT * FROM preferences').all()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].level, 'strong')
  store.close()
})
