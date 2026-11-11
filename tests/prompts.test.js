import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SYSTEM_SECTION,
  EXPANDED_PROTOCOL,
  PRESENTATION_SKELETON,
  auditAnswer,
  preferenceReminder,
  noConsensusText,
} from '../lib/prompts.js'

test('常驻段足够短：≤240 字符（折中方案的核心约束）', () => {
  assert.ok(SYSTEM_SECTION.length <= 240, `常驻段 ${SYSTEM_SECTION.length} 字符，超出预算`)
})

test('常驻段包含三个触发要素：主观/客观分流、工具顺序、人气禁令', () => {
  assert.match(SYSTEM_SECTION, /主观/)
  assert.match(SYSTEM_SECTION, /客观/)
  assert.match(SYSTEM_SECTION, /pref_lookup/)
  assert.match(SYSTEM_SECTION, /pref_sample/)
  assert.match(SYSTEM_SECTION, /pref_record/)
  assert.match(SYSTEM_SECTION, /主流/)
})

test('细则搬到 EXPANDED_PROTOCOL，且比常驻段长（确实承担了展开职责）', () => {
  assert.ok(EXPANDED_PROTOCOL.length > SYSTEM_SECTION.length * 2)
  assert.match(EXPANDED_PROTOCOL, /strong/)
  assert.match(EXPANDED_PROTOCOL, /weak/)
  assert.match(EXPANDED_PROTOCOL, /none/)
  assert.match(EXPANDED_PROTOCOL, /推导，非流行度证据/)
})

test('常驻段不再包含逐档细则（否则等于没瘦身）', () => {
  assert.ok(!SYSTEM_SECTION.includes('推导，非流行度证据'))
  assert.ok(!SYSTEM_SECTION.includes('代表案例'))
})

test('auditAnswer：无来源时人气词被抓、有来源时放行', () => {
  assert.equal(auditAnswer('这是主流做法').ok, false)
  assert.deepEqual(auditAnswer('这是主流做法').violations, ['主流'])
  assert.equal(auditAnswer('这是主流做法', { hasSources: true }).ok, true)
  assert.equal(auditAnswer('给两个候选，各有代价').ok, true)
})

test('preferenceReminder：按等级换措辞，可例外/过期加后缀', () => {
  const found = {
    found: true,
    level: 'global',
    canException: true,
    stale: false,
    direction: { name: '冷色专业', description: '深蓝主色 + 大留白' },
  }
  const s = preferenceReminder(found)
  assert.match(s, /一贯偏好/)
  assert.match(s, /冷色专业/)
  assert.match(s, /可例外/)
  assert.equal(preferenceReminder({ found: false }), '')
})

test('noConsensusText：原因码翻成人话，未知码原样透出', () => {
  assert.match(noConsensusText('single_domain'), /单一来源/)
  assert.match(noConsensusText('search_failed'), /搜索请求失败/)
  assert.match(noConsensusText('weird_code'), /weird_code/)
})

test('呈现骨架保留五段结构', () => {
  for (const key of ['代表案例', '优点', '代价', '适合', '你更看重什么']) {
    assert.ok(PRESENTATION_SKELETON.includes(key), `骨架缺少「${key}」`)
  }
})
