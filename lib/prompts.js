/**
 * 提示词与输出约束。auditAnswer 用于自检「有没有编造人气」。
 */

export const SYSTEM_SECTION = `# 主观问题的处理方式（dsh-self-taught）

主观问题＝没有标准答案、取决于情境与个人偏好的问题（审美、风格、取舍、命名、方案选择）。
客观问题＝有客观对错或唯一解的问题（报错、语法、API 用法、事实查询、计算）。

**判定**：一句话 + 有无代码/报错信息 + 被问对象是不是「风格/取舍/偏好」。拿不准时问一句，别硬套流程。

**主观问题必须按这个顺序做**：
1. 先调 \`pref_lookup\`（problem_type + situation_tags）。有强偏好就按它给方案，并写明「按你上次的偏好…（可例外）」；没有就往下。
2. 调 \`pref_sample\` 联网采样。只在当前确实需要外部事实时调，不要为了走流程而调。
3. 采样结果分三档：
   - \`strong\`：可以聚类出 2~3 个方向，每个方向给「代表案例 + 来源链接 + 优点 + 代价 + 适合什么情境」。
   - \`weak\`：方向照给，但必须写明「样本有限（N 个来源 / M 个域名），只作参考」。
   - \`none\`：**不许编造人气**。直接说「这个情境下我没有找到可靠共识（原因：…）」，然后给按原则推导的候选，每个都标「推导，非流行度证据」。
4. 绝不替用户拍板，把最后判断交回用户（给「你更看重什么 → 选哪个」）。
5. 用户选定后调 \`pref_record\` 记下来（带理由）。记录是代码算等级，你不要自报等级。

**硬约束**：
- 没有来源就不许出现「主流 / 大多数人 / 最流行 / 大家都 / 公认 / 行业标准」这类人气断言。
- 方向数不超过 3 个。每个方向必须有代价，不许只写优点。
- 客观问题不要走这套流程，正常回答。
- 用户明确要求「直接给答案」时，直接给，但仍可补一句「这与你的历史偏好一致/相反」。`

export const DIRECTION_RULES = {
  maxDirections: 3,
  minDomainsPerDirection: 2,
  bucketsRule: '按评价词/做法分桶，不按网站分桶',
}

export const NO_CONSENSUS_NOTICE =
  '这个情境下我没有找到可靠共识（原因：{reason}）。下面是按原则推导的候选，不是「大家都在用」的证据。'

export const PRESENTATION_SKELETON = `这类问题没有唯一答案，取决于{keyVariable}。我找到 {n} 个方向：

### 方向 1：{name}
- 代表案例：{example} — [来源]({url})
- 优点：{pros}
- 代价：{cons}
- 适合：{fit}

### 你更看重什么？
A. 更在意 {x} → 方向 1
B. 更在意 {y} → 方向 2`

const HYPE_WORDS = ['主流', '大多数人', '最流行', '大家都', '公认', '行业标准', '普遍认为', '毫无疑问']

/**
 * 自检：没有来源却出现人气断言 → 违规。
 * @returns {{ok:boolean, violations:string[]}}
 */
export function auditAnswer(text, { hasSources = false } = {}) {
  const src = String(text || '')
  const violations = []
  if (hasSources) return { ok: true, violations }
  for (const w of HYPE_WORDS) {
    if (src.includes(w)) violations.push(w)
  }
  return { ok: violations.length === 0, violations }
}

export function preferenceReminder(lookup) {
  if (!lookup?.found) return ''
  const { direction, level, canException, stale } = lookup
  const strengthText = level === 'global' ? '你在这类问题上的一贯偏好' : '你上次的偏好'
  const tail = canException ? '（可例外）' : stale ? '（较久未验证）' : ''
  return `按${strengthText}：${direction.name}${direction.description ? `（${direction.description}）` : ''}${tail}`
}

export function noConsensusText(reason) {
  const map = {
    provider_unavailable: '搜索不可用',
    search_failed: '搜索请求失败',
    no_results: '没有搜到结果',
    single_domain: '结果集中在单一来源',
    empty_question: '问题里没有可检索的关键词',
  }
  return NO_CONSENSUS_NOTICE.replace('{reason}', map[reason] || reason || '未知原因')
}
