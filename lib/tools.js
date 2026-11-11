import { PROBLEM_TYPES, situationBucket, situationTags } from './classify.js'
import { lookup, nextLevel } from './escalate.js'
import { samplePreference, validateDirections, canonicalUrl } from './sample.js'
import { preferenceReminder, noConsensusText, auditAnswer, EXPANDED_PROTOCOL } from './prompts.js'
import { computeConfidence } from './confidence.js'

const text = (s) => [{ type: 'text', text: String(s) }]

/** 采样结果的三档处置提示：只在真的采样时付这段 token，不常驻。 */
function sampleGuidance(value) {
  const s = value.stats || {}
  if (value.strength === 'none') {
    const detail = value.error ? `（失败原因：${value.error}）` : ''
    return (
      `**none：不许编造人气。** 首句用「${noConsensusText(value.reason)}」，` +
      `然后给按原则推导的候选，每个标「推导，非流行度证据」。${detail}`
    )
  }
  if (value.strength === 'weak') {
    return (
      `**weak：** 方向照给，但必须写明「样本有限（${s.sourceCount ?? 0} 个来源 / ` +
      `${s.domainCount ?? 0} 个域名），只作参考」。`
    )
  }
  return '**strong：** 聚类 2~3 个方向，每个给「代表案例 + 来源链接 + 优点 + 代价 + 适合什么情境」；最后把判断交回用户。'
}
const tagsSchema = {
  type: 'array',
  items: { type: 'string' },
  description: '情境标签，如 platform_web / audience_b2b / context_personal / long_term。没有就给空数组。',
}

export function buildTools({ store, search, cfg }) {
  return [
    lookupTool({ store, cfg }),
    sampleTool({ store, search, cfg }),
    recordTool({ store, cfg }),
  ]
}

function lookupTool({ store, cfg }) {
  return {
    name: 'pref_lookup',
    description:
      '查用户的历史偏好。主观问题先用它，不要在没查之前就按模型自己的喜好回答。返回等级、是否可例外、以及可以直接写进回答的一句话。',
    parameters: {
      type: 'object',
      properties: {
        problem_type: { type: 'string', enum: PROBLEM_TYPES, description: '问题类型' },
        situation_tags: tagsSchema,
        question: { type: 'string', description: '用户的原问题，用于记录与情境匹配（可选）' },
      },
      required: ['problem_type', 'situation_tags'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) =>
        text(
          value.found
            ? value.advice
            : `没有历史偏好（${value.reason}）。下一步按这个流程做：\n${EXPANDED_PROTOCOL}`,
        ),
    },
    async execute(args = {}) {
      const type = String(args.problem_type || 'other')
      const tags = Array.isArray(args.situation_tags) ? args.situation_tags : []
      const bucket = situationBucket(tags)
      const history = store.historyFor(type)
      const found = lookup(history, {
        now: new Date().toISOString(),
        staleDays: cfg.staleDays,
        exceptionWindowDays: cfg.exceptionWindowDays,
        bucket,
      })
      return {
        ...found,
        bucket,
        advice: found.found ? preferenceReminder(found) : '',
        totalObservations: history.length,
      }
    },
  }
}

function sampleTool({ store, search, cfg }) {
  return {
    name: 'pref_sample',
    description:
      '联网采样某个主观问题在这个情境下的流行做法。返回来源、域名分布和三档强度（strong/weak/none）。none 时必须如实告诉用户缺乏共识，不许编造人气。',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '用户的原问题' },
        problem_type: { type: 'string', enum: PROBLEM_TYPES },
        situation_tags: tagsSchema,
        max_results: { type: 'number', description: '每次查询取几条，默认 10' },
      },
      required: ['question', 'problem_type', 'situation_tags'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => {
        const s = value.stats || {}
        const head =
          `strength=${value.strength} sources=${s.sourceCount ?? 0} domains=${s.domainCount ?? 0} ` +
          `dated=${s.datedShare ?? 0} reason=${value.reason}`
        return text(`${head}\n${sampleGuidance(value)}`)
      },
    },
    async execute(args = {}) {
      const question = String(args.question || '')
      const problemType = String(args.problem_type || 'other')
      const tags = Array.isArray(args.situation_tags) ? args.situation_tags : []
      if (!situationTags(question).length && tags.length === 0) {
        // 只做提示：情境为空会让偏好无法按情境区分
        tags.push('general_hint')
      }

      const result = await samplePreference({
        search,
        question,
        problemType,
        tags,
        maxResults: Math.min(20, Number(args.max_results) || cfg.sampleMaxResults),
        timeoutMs: 12000,
      })

      const run = store.addSamplingRun({
        question,
        problem_type: problemType,
        queries: result.queries,
        source_count: result.stats.sourceCount,
        domain_count: result.stats.domainCount,
        top_domain_share: result.stats.topDomainShare,
        dated_share: result.stats.datedShare,
        strength: result.strength,
        degraded: result.degraded,
        reason: result.reason,
        sources: result.sources.slice(0, 30),
      })

      const sources = result.sources.slice(0, 20).map((s) => ({
        title: s.title || '',
        url: s.url,
        host: s.host,
        publishedAt: s.publishedAt || null,
        snippet: s.snippet ? String(s.snippet).slice(0, 300) : '',
      }))

      return {
        run_id: run.id,
        strength: result.strength,
        degraded: result.degraded,
        reason: result.reason,
        error: result.error,
        stats: result.stats,
        by_domain: result.byDomain,
        queries: result.queries,
        sources,
        caveat: result.strength === 'none' ? noConsensusText(result.reason) : noCaveat(result.strength, result.stats),
        rules: {
          max_directions: cfg.maxDirections,
          require_2_domains_per_direction: true,
          derived_must_be_labeled: true,
          no_hype_words_without_sources: true,
        },
      }
    },
  }
}

function noCaveat(strength, stats) {
  if (strength === 'strong') return `样本较充分（${stats.sourceCount} 个来源 / ${stats.domainCount} 个域名），可以聚类 2~3 个方向。`
  return `样本有限（${stats.sourceCount} 个来源 / ${stats.domainCount} 个域名），方向照给但必须注明样本不足。`
}

function recordTool({ store, cfg }) {
  return {
    name: 'pref_record',
    description:
      '用户做出选择后记录偏好。等级与范围由代码计算，返回值即为准；不要自己判断等级。用户说「以后都这样」时传 explicit_global=true。',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '原问题' },
        problem_type: { type: 'string', enum: PROBLEM_TYPES },
        situation_tags: tagsSchema,
        chosen_name: { type: 'string', description: '用户选的方向名（短，可复用）' },
        chosen_description: { type: 'string', description: '这个方向的一句话描述（可选）' },
        reason: { type: 'string', description: '用户给出的理由，尽量原话（可选）' },
        explicit_global: { type: 'boolean', description: '用户是否明确表示「以后都按这个来」' },
        sampling_strength: { type: 'string', enum: ['strong', 'weak', 'none'] },
        sampling_run_id: { type: 'string' },
        sampled_options: { type: 'array', items: { type: 'string' }, description: '当时呈现的方向名列表' },
        directions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              sources: { type: 'array', items: { type: 'string' } },
              derived: { type: 'boolean' },
            },
            required: ['name'],
          },
          description: '当时给出的方向（含来源），用于校验有没有编造来源',
        },
      },
      required: ['question', 'problem_type', 'chosen_name'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) =>
        text(
          value.recorded
            ? `已记录：${value.direction_name} → level=${value.level} scope=${value.scope} count=${value.same_direction_count}`
            : `未记录：${value.error}`,
        ),
    },
    async execute(args = {}) {
      const question = String(args.question || '')
      const problemType = String(args.problem_type || 'other')
      const name = String(args.chosen_name || '').trim()
      if (!name) return { recorded: false, error: 'chosen_name_required' }

      const tags = Array.isArray(args.situation_tags) ? args.situation_tags : situationTags(question)
      const bucket = situationBucket(tags)
      const history = store.historyFor(problemType)

      const audit = Array.isArray(args.directions)
        ? validateDirections(args.directions, [], { maxDirections: cfg.maxDirections })
        : { ok: true, problems: [], directions: [] }

      const next = nextLevel({
        history,
        incoming: { name, bucket, explicitGlobal: Boolean(args.explicit_global), problemType },
        now: new Date().toISOString(),
      })

      const recentSame = history.filter((r) => r.user_choice_name === name)
      const lastSeen = recentSame.length ? recentSame[recentSame.length - 1].created_at : null
      const ageDays = lastSeen
        ? Math.max(0, Math.floor((Date.now() - Date.parse(lastSeen)) / 86400000))
        : 0
      const confidence = computeConfidence({
        strength: args.sampling_strength || 'weak',
        domainCount: new Set(tags).size,
        ageDays,
        staleDays: cfg.staleDays,
        grounded: Boolean(args.sampling_run_id),
        explicitGlobal: Boolean(args.explicit_global),
      })

      const { id, created_at } = store.addObservation({
        question,
        problem_type: problemType,
        situation_tags: tags,
        situation_bucket: bucket,
        sampling_strength: args.sampling_strength ?? null,
        sampling_run_id: args.sampling_run_id ?? null,
        sampled_options: Array.isArray(args.sampled_options) ? args.sampled_options : [],
        user_choice: name,
        user_choice_name: name,
        user_choice_description: args.chosen_description ?? null,
        user_reason: args.reason ?? null,
        explicit_global: Boolean(args.explicit_global),
        confidence,
        level_after: next.level,
        scope_after: next.scope,
        same_direction_count: next.sameDirectionCount,
      })

      store.upsertPreference({
        problem_type: problemType,
        situation_bucket: bucket,
        direction_name: name,
        level: next.level,
        scope: next.scope,
        same_direction_count: next.sameDirectionCount,
        distinct_buckets: next.distinctBuckets,
        last_seen: created_at,
      })

      const hint =
        next.level === 'global'
          ? '这已经成为跨情境偏好，以后这类问题可以直给并标「可例外」。'
          : next.level === 'strong'
            ? '同一方向已出现 2 次，可以主动优先给出，但仍要说明依据。'
            : '只是这一次的选择，下次仍要先查偏好、再决定是否采样。'

      return {
        recorded: true,
        id,
        created_at,
        direction_name: name,
        level: next.level,
        scope: next.scope,
        same_direction_count: next.sameDirectionCount,
        distinct_buckets: next.distinctBuckets,
        downgraded_from: next.downgradedFrom,
        confidence,
        audit: audit.problems,
        hint,
      }
    },
  }
}
