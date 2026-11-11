import test from 'node:test'
import assert from 'node:assert/strict'
import { nextLevel, lookup, downgradeForStaleness } from '../lib/escalate.js'

const at = (day) => new Date(Date.UTC(2026, 0, day)).toISOString()

function row(name, { day = 1, bucket = 'general', type = 'visual_style', explicit = false } = {}) {
  return {
    user_choice_name: name,
    situation_bucket: bucket,
    problem_type: type,
    created_at: at(day),
    explicit_global: explicit,
  }
}

test('第一次选择 → weak / situation', () => {
  const r = nextLevel({ history: [], incoming: { name: 'A', bucket: 'b1' } })
  assert.equal(r.level, 'weak')
  assert.equal(r.scope, 'situation')
  assert.equal(r.sameDirectionCount, 1)
})

test('同一方向第二次 → strong', () => {
  const r = nextLevel({ history: [row('A')], incoming: { name: 'A', bucket: 'general' } })
  assert.equal(r.level, 'strong')
  assert.equal(r.scope, 'situation')
  assert.equal(r.sameDirectionCount, 2)
})

test('同一方向第三次 → global', () => {
  const r = nextLevel({ history: [row('A', { day: 1 }), row('A', { day: 2 })], incoming: { name: 'A', bucket: 'general' } })
  assert.equal(r.level, 'global')
  assert.equal(r.scope, 'global')
})

test('改选别的方向 → 新方向仍是 weak，并报告降级来源', () => {
  const history = [row('A', { day: 1 }), row('A', { day: 2 })]
  const r = nextLevel({ history, incoming: { name: 'B', bucket: 'general' } })
  assert.equal(r.level, 'weak')
  assert.equal(r.downgradedFrom.name, 'A')
  assert.equal(r.downgradedFrom.level, 'strong')
  assert.match(r.reason, /contradicts_previous/)
})

test('明确「以后都这样」→ 直接 global', () => {
  const r = nextLevel({ history: [], incoming: { name: 'A', bucket: 'b1', explicitGlobal: true } })
  assert.equal(r.level, 'global')
  assert.match(r.reason, /explicit_global/)
})

test('other 类永远不升级为全局', () => {
  const history = [row('A', { day: 1, type: 'other' }), row('A', { day: 2, type: 'other' })]
  const r = nextLevel({ history, incoming: { name: 'A', bucket: 'general', problemType: 'other' } })
  assert.equal(r.level, 'strong')
  assert.match(r.reason, /other_type_capped/)
})

test('跨三个情境桶 → 至少 strong（即使不连续）', () => {
  const r = nextLevel({
    history: [
      row('A', { day: 1, bucket: 'b1' }),
      row('B', { day: 2, bucket: 'b2' }),
      row('A', { day: 3, bucket: 'b3' }),
      row('B', { day: 4, bucket: 'b4' }),
    ],
    incoming: { name: 'A', bucket: 'b5' },
  })
  assert.equal(r.distinctBuckets, 3)
  assert.equal(r.level, 'strong')
  assert.match(r.reason, /cross_situation_3_buckets/)
})

test('陈旧偏好降一级', () => {
  const now = at(300)
  const info = downgradeForStaleness('global', at(1), now, 90)
  assert.equal(info.stale, true)
  assert.equal(info.level, 'strong')
  const fresh = downgradeForStaleness('global', at(299), now, 90)
  assert.equal(fresh.stale, false)
  assert.equal(fresh.level, 'global')
})

test('lookup：没有历史时 found=false', () => {
  assert.equal(lookup([], {}).found, false)
})

test('lookup：读到强偏好并给出可例外', () => {
  const rows = [row('A', { day: 1 }), row('A', { day: 2 }), row('B', { day: 3 })]
  const r = lookup(rows, { now: at(3), staleDays: 90, exceptionWindowDays: 30, bucket: 'general' })
  assert.equal(r.found, true)
  assert.equal(r.direction.name, 'A')
  assert.equal(r.level, 'strong')
  assert.equal(r.canException, true)
  assert.deepEqual(r.contraryNames, ['B'])
})

test('lookup：只出现一次时是 weak，且无例外', () => {
  const r = lookup([row('A', { day: 1 })], { now: at(1), staleDays: 90, exceptionWindowDays: 30 })
  assert.equal(r.level, 'weak')
  assert.equal(r.canException, false)
})

test('lookup：陈旧记录降级并标 stale', () => {
  const r = lookup([row('A', { day: 1 }), row('A', { day: 2 }), row('A', { day: 3 })], {
    now: at(300),
    staleDays: 90,
    exceptionWindowDays: 30,
  })
  assert.equal(r.rawLevel, 'global')
  assert.equal(r.level, 'strong')
  assert.equal(r.stale, true)
})
