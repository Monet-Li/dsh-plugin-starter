import test from 'node:test'
import assert from 'node:assert/strict'
import { detectIntent, situationBucket, situationTags, guessProblemType } from '../lib/classify.js'

test('客观问题：报错信息不触发主观流程', () => {
  const r = detectIntent('这段代码为什么报错：TypeError: Cannot read properties of undefined (reading map)')
  assert.equal(r.verdict, 'no')
  assert.ok(r.objectiveHits.length >= 1)
})

test('客观问题：带代码块一律判否', () => {
  const r = detectIntent('帮我看看这个\n```js\nconst a = b.c\n```\n为什么不能运行')
  assert.equal(r.verdict, 'no')
  assert.equal(r.reason, 'contains_code')
})

test('客观问题：单个客观词就否决，哪怕同时有主观词', () => {
  const r = detectIntent('这个配色不错，但构建失败是什么原因')
  assert.equal(r.verdict, 'no')
  assert.equal(r.reason, 'objective_marker')
})

test('主观问题：落地页配色', () => {
  const r = detectIntent('帮我选落地页配色')
  assert.equal(r.verdict, 'yes')
  assert.equal(r.problemType, 'visual_style')
  assert.ok(r.situationTags.includes('platform_web'))
})

test('主观问题：命名类', () => {
  const r = detectIntent('给这个开源库起名，选哪个好')
  assert.equal(r.verdict, 'yes')
  assert.equal(r.problemType, 'naming')
  assert.ok(r.situationTags.includes('context_opensource'))
})

test('弱信号只给 maybe', () => {
  const r = detectIntent('这个看起来更好')
  assert.equal(r.verdict, 'maybe')
  assert.equal(r.reason, 'single_weak_cue')
})

test('无信号判否', () => {
  const r = detectIntent('今天天气不错')
  assert.equal(r.verdict, 'no')
  assert.equal(r.problemType, 'other')
})

test('情境标签与桶稳定', () => {
  const tags = situationTags('中文网页项目，个人项目，长期维护')
  assert.deepEqual([...tags].sort(), ['context_personal', 'locale_zh', 'long_term', 'platform_web'])
  assert.equal(situationBucket(tags), situationBucket([...tags].reverse()))
  assert.equal(situationBucket([]), 'general')
})

test('类型猜测按命中数取最大', () => {
  assert.equal(guessProblemType('配色 字体 排版 风格 都想要').type, 'visual_style')
})
