/**
 * 偏好升级/降级状态机。全部是纯函数，输入历史与本次选择，输出等级与范围。
 * 等级是「代码算出来的」，不许模型自报。
 */

export const LEVELS = ['none', 'weak', 'strong', 'global']
const RANK = { none: 0, weak: 1, strong: 2, global: 3 }

export function levelRank(level) {
  return RANK[level] ?? 0
}

export function raise(level, steps = 1) {
  const i = Math.min(LEVELS.length - 1, levelRank(level) + steps)
  return LEVELS[i]
}

export function lower(level, steps = 1) {
  const i = Math.max(0, levelRank(level) - steps)
  return LEVELS[i]
}

function countFromLevel(n) {
  if (n >= 3) return 'global'
  if (n === 2) return 'strong'
  if (n === 1) return 'weak'
  return 'none'
}

function bucketOf(row) {
  return row.situation_bucket || 'general'
}

/**
 * @param {object} p
 * @param {Array} p.history 同 problem_type 的历史 observation，按时间升序
 * @param {{name:string, bucket?:string, explicitGlobal?:boolean, problemType?:string}} p.incoming
 */
export function nextLevel({ history = [], incoming, now } = {}) {
  const rows = Array.isArray(history) ? history : []
  const name = incoming?.name ?? ''
  const bucket = incoming?.bucket || 'general'
  const problemType = incoming?.problemType ?? rows[0]?.problem_type ?? null

  const same = rows.filter((r) => r.user_choice_name === name)
  let consecutive = 0
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rows[i].user_choice_name !== name) break
    consecutive += 1
  }

  const buckets = new Set(same.map(bucketOf))
  buckets.add(bucket)

  const sameDirectionCount = same.length + 1
  const count = consecutive + 1

  let level = countFromLevel(count)
  const reasons = []

  if (buckets.size >= 3) {
    reasons.push('cross_situation_3_buckets')
    // 跨情境是强化信号：升一级（weak→strong，strong→global），不额外封顶
    level = raise(level, 1)
  }
  if (incoming?.explicitGlobal) {
    reasons.push('explicit_global')
    level = 'global'
  }
  // 'other' 类永远不升级为全局，避免误伤（只有显式判定为 other 时才生效）
  if (problemType === 'other' && level === 'global') {
    reasons.push('other_type_capped')
    level = 'strong'
  }

  let downgradedFrom = null
  if (count === 1 && rows.length > 0) {
    const previous = prevailing(rows)
    if (previous && previous.name !== name && levelRank(previous.level) >= RANK.weak) {
      downgradedFrom = { name: previous.name, level: previous.level }
      reasons.push('contradicts_previous')
    }
  }

  return {
    level,
    scope: level === 'global' ? 'global' : 'situation',
    sameDirectionCount,
    consecutive: count,
    distinctBuckets: buckets.size,
    downgradedFrom,
    reason: reasons.join(',') || 'count_based',
    decidedAt: now || new Date().toISOString(),
  }
}

function prevailing(rows) {
  const byName = new Map()
  for (const r of rows) {
    const n = r.user_choice_name
    if (!n) continue
    const cur = byName.get(n) || { name: n, count: 0, last: '' }
    cur.count += 1
    const ts = r.created_at || ''
    if (ts > cur.last) cur.last = ts
    byName.set(n, cur)
  }
  let best = null
  for (const v of byName.values()) {
    const level = countFromLevel(v.count)
    if (!best || levelRank(level) > levelRank(best.level) || (levelRank(level) === levelRank(best.level) && v.last > best.last)) {
      best = { name: v.name, level, count: v.count, last: v.last }
    }
  }
  return best
}

export function downgradeForStaleness(level, lastSeen, now, staleDays = 90) {
  if (!lastSeen) return { level, stale: false, ageDays: null }
  const seenAt = Date.parse(lastSeen)
  const nowMs = now ? Date.parse(now) : Date.now()
  if (!Number.isFinite(seenAt) || !Number.isFinite(nowMs)) return { level, stale: false, ageDays: null }
  const ageDays = Math.floor((nowMs - seenAt) / 86400000)
  if (ageDays <= staleDays) return { level, stale: false, ageDays }
  return { level: lower(level, 1), stale: true, ageDays }
}

/**
 * 读偏好：给某个 (problem_type, 情境) 的历史，返回「该按哪个方向回答」。
 * @param {Array} rows 同 problem_type 的 observation（升序或乱序都可）
 */
export function lookup(rows = [], { now, staleDays = 90, exceptionWindowDays = 30, bucket } = {}) {
  const list = Array.isArray(rows) ? rows.slice() : []
  if (!list.length) return { found: false, level: 'none', reason: 'no_history' }

  const byName = new Map()
  for (const r of list) {
    const n = r.user_choice_name
    if (!n) continue
    const cur = byName.get(n) || {
      name: n,
      description: r.user_choice_description || '',
      count: 0,
      last: '',
      buckets: new Set(),
      explicit: false,
    }
    cur.count += 1
    if ((r.created_at || '') > cur.last) cur.last = r.created_at || ''
    cur.buckets.add(bucketOf(r))
    if (r.explicit_global) cur.explicit = true
    if (!cur.description && r.user_choice_description) cur.description = r.user_choice_description
    byName.set(n, cur)
  }

  const candidates = [...byName.values()].map((c) => {
    let level = c.count >= 3 ? 'global' : countFromLevel(c.count)
    if (c.explicit) level = 'global'
    if (c.buckets.size >= 3) level = levelRank(level) >= RANK.strong ? level : 'strong'
    return { ...c, rawLevel: level, buckets: [...c.buckets] }
  })
  if (!candidates.length) return { found: false, level: 'none', reason: 'no_named_choice' }

  candidates.sort((a, b) => {
    const d = levelRank(b.rawLevel) - levelRank(a.rawLevel)
    if (d !== 0) return d
    return (b.last || '').localeCompare(a.last || '')
  })
  const top = candidates[0]
  const staleInfo = downgradeForStaleness(top.rawLevel, top.last, now, staleDays)

  const nowMs = now ? Date.parse(now) : Date.now()
  const windowStart = Number.isFinite(nowMs) ? nowMs - exceptionWindowDays * 86400000 : -Infinity
  const contrary = list.filter((r) => {
    if (!r.user_choice_name || r.user_choice_name === top.name) return false
    const ts = Date.parse(r.created_at || '')
    return Number.isFinite(ts) ? ts >= windowStart : true
  })

  const inThisBucket = bucket ? list.filter((r) => bucketOf(r) === bucket) : []

  return {
    found: true,
    direction: {
      name: top.name,
      description: top.description,
      sameDirectionCount: top.count,
      distinctBuckets: top.buckets,
      lastSeen: top.last,
    },
    level: staleInfo.level,
    rawLevel: top.rawLevel,
    scope: staleInfo.level === 'global' ? 'global' : 'situation',
    stale: staleInfo.stale,
    ageDays: staleInfo.ageDays,
    canException: contrary.length > 0 || staleInfo.stale,
    contraryCount: contrary.length,
    contraryNames: [...new Set(contrary.map((r) => r.user_choice_name))],
    evidenceInBucket: inThisBucket.length,
    reason: staleInfo.stale ? 'stale_downgraded' : 'count_based',
  }
}
