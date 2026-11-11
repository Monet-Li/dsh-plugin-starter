/**
 * 冒烟测试：用一个假的 ctx 跑一遍 apply()，确认注册的东西对、坏掉的依赖不会炸。
 * 用法：node scripts/smoke.mjs
 */
import { apply } from '../index.js'

const registered = { sections: [], tools: [], effects: 0 }

const fakeCtx = (search) => ({
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  systemPrompt: {
    section(section) {
      registered.sections.push(section)
      return () => {}
    },
  },
  tools: {
    register(definition) {
      registered.tools.push(definition)
      return () => {}
    },
  },
  web: search ? { search } : undefined,
  effect(fn) {
    registered.effects += 1
    return fn
  },
})

const search = async ({ query }) => ({
  sources: [
    { url: 'https://a.com/1', title: `A ${query}`, publishedAt: '2026-10-01' },
    { url: 'https://b.com/2', title: `B ${query}`, publishedAt: '2026-10-02' },
    { url: 'https://c.com/3', title: `C ${query}`, publishedAt: '2026-10-03' },
    { url: 'https://d.com/4', title: `D ${query}`, publishedAt: '2026-10-04' },
    { url: 'https://e.com/5', title: `E ${query}`, publishedAt: '2026-10-05' },
    { url: 'https://f.com/6', title: `F ${query}`, publishedAt: '2026-10-06' },
  ],
  truncated: false,
})

apply(fakeCtx(search), { mode: 'auto', dbPath: ':memory:' })

console.log('sections:', registered.sections.map((s) => `${s.name}#${s.order} (${s.text.length} chars)`))
console.log('tools:', registered.tools.map((t) => t.name))
console.log('effects:', registered.effects)

const sample = registered.tools.find((t) => t.name === 'pref_sample')
const lookup = registered.tools.find((t) => t.name === 'pref_lookup')
const record = registered.tools.find((t) => t.name === 'pref_record')
if (!sample || !lookup || !record) throw new Error('工具没有全部注册')

const sampled = await sample.execute({
  question: '帮我选落地页配色',
  problem_type: 'visual_style',
  situation_tags: ['platform_web', 'audience_b2b'],
})
console.log('sample →', sampled.strength, sampled.stats, 'sources:', sampled.sources.length)

const before = await lookup.execute({ problem_type: 'visual_style', situation_tags: ['platform_web'] })
console.log('lookup before →', before.found)

const rec = await record.execute({
  question: '帮我选落地页配色',
  problem_type: 'visual_style',
  situation_tags: ['platform_web', 'audience_b2b'],
  chosen_name: '冷色专业',
  chosen_description: '深蓝主色 + 大留白',
  reason: '客户是 B 端',
  sampling_strength: sampled.strength,
  sampling_run_id: sampled.run_id,
  sampled_options: ['冷色专业', '暖色活泼'],
})
console.log('record →', rec.level, rec.scope, 'audit:', rec.audit)

const after = await lookup.execute({ problem_type: 'visual_style', situation_tags: ['platform_web'] })
console.log('lookup after →', after.found, after.level, '|', after.advice)

// 没有 web.search 时不应该抛
registered.sections.length = 0
registered.tools.length = 0
apply(fakeCtx(undefined), { mode: 'auto', dbPath: ':memory:' })
const noNet = await registered.tools.find((t) => t.name === 'pref_sample').execute({
  question: '帮我选落地页配色',
  problem_type: 'visual_style',
  situation_tags: ['platform_web'],
})
console.log('no-network →', noNet.strength, '|', noNet.caveat)

// mode: off 什么都不注册
registered.sections.length = 0
registered.tools.length = 0
apply(fakeCtx(search), { mode: 'off' })
console.log('off mode → sections:', registered.sections.length, 'tools:', registered.tools.length)

console.log('SMOKE OK')
