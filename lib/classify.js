/**
 * 只做「召回」：判断一句话像不像主观问题，给出类型与情境线索。
 * 最终裁定权在主模型（它看得见项目上下文），这里不假装能精确分类。
 */

export const PROBLEM_TYPES = [
  'visual_style',
  'copy_tone',
  'tech_choice',
  'product_tradeoff',
  'workflow',
  'naming',
  'content_structure',
  'lifestyle',
  'other',
]

export const TYPE_KEYWORDS = {
  visual_style: ['配色', '颜色', '色彩', '配色方案', '视觉', '风格', '字体', '排版', '布局', '设计', '图标', 'logo', '海报', '界面', 'ui', 'ux', '主题色', '深色', '浅色', '插画'],
  copy_tone: ['文案', '语气', '措辞', '标题', 'slogan', '口号', '口吻', '调性', '写得', '开头', '结尾', '措词', '卖点描述'],
  tech_choice: ['用什么', '该不该用', '选型', '框架', '库', '数据库', '语言', '架构', '部署', 'orm', '状态管理', '依赖', '技术栈', '方案选'],
  product_tradeoff: ['取舍', '值不值', '要不要做', '优先级', 'mvp', '范围', '功能', '商业化', '定价', '需求', '权衡'],
  workflow: ['流程', '工作流', '效率', '习惯', '节奏', '安排', '协作', '评审', '提交', '分支策略'],
  naming: ['命名', '取名', '起名', '名字', '域名', '包名', '变量名', '叫什么', '怎么叫'],
  content_structure: ['结构', '大纲', '目录', '章节', '顺序', '组织', '信息架构', '怎么讲', '组织成'],
  lifestyle: ['生活', '作息', '运动', '旅行', '读书', '学习方式', '装备', '买哪个', '耳机', '键盘', '咖啡'],
}

/** 命中任一项，基本可判定为客观/排障类问题 */
export const OBJECTIVE_MARKERS = [
  '报错', '错误信息', '异常', '崩溃', '堆栈', '堆栈信息', 'traceback', 'stack trace',
  '不工作', '没反应', '起不来', '跑不通', '编译失败', '构建失败', '类型错误', '语法错误',
  '为什么报', '为什么不能', '为什么失败', '怎么修', '怎么解决', '排查',
  'undefined is not', 'cannot read', 'typeerror', 'referenceerror', 'syntaxerror',
  'exit code', 'npm err', 'pnpm err', 'econnrefused', 'etimedout', 'segmentation fault',
]

export const SUBJECTIVE_CUES = [
  '帮我选', '选哪个', '该选', '挑一个', '哪个好', '哪个更', '用什么好', '推荐', '建议用',
  '好不好看', '顺眼', '舒服', '感觉', '氛围', '合适吗', '可以吗', '行不行',
  '还是', '对比', '取舍', '值不值', '要不要', '该不该', '更好', '更合适',
  '你喜欢', '你觉得', '怎么看', '风格', '调性',
]

/** 情境标签：用于把「同一类问题」切分成不同情境桶 */
export const SITUATION_KEYWORDS = {
  platform_web: ['网页', '网站', 'web', '浏览器', '落地页', '官网', 'h5'],
  platform_mobile: ['移动端', '手机', 'app', '小程序', 'ios', '安卓', 'android'],
  platform_desktop: ['桌面', '客户端', 'electron', '桌面端'],
  audience_b2b: ['b2b', '企业', '客户是公司', '商用', 'to b'],
  audience_b2c: ['b2c', '个人用户', '消费者', 'to c', '用户增长'],
  audience_developer: ['开发者', '程序员', '技术人', '开源用户', '工程师'],
  context_personal: ['个人项目', '自己的', '业余', 'side project', '练手'],
  context_team: ['团队', '多人', '协作', '同事', '公司项目'],
  context_opensource: ['开源', 'github', '仓库', 'npm 包'],
  budget_low: ['预算低', '没钱', '免费', '省钱', '零成本'],
  time_short: ['赶时间', '快速', '一周内', '立刻', '短期'],
  long_term: ['长期', '维护', '可持续', '多年'],
  locale_zh: ['中文', '国内', '中国用户', '简体'],
  locale_en: ['英文', '海外', '国际化', '英文用户'],
  brand_serious: ['正式', '专业', '严肃', '企业级', '稳重'],
  brand_playful: ['活泼', '有趣', '年轻', '轻松', '搞怪'],
}

export function situationTags(text) {
  const lower = String(text || '').toLowerCase()
  const tags = []
  for (const [tag, words] of Object.entries(SITUATION_KEYWORDS)) {
    if (words.some((w) => lower.includes(w.toLowerCase()))) tags.push(tag)
  }
  return tags
}

export function situationBucket(tags) {
  const list = Array.isArray(tags) ? tags.filter(Boolean).map(String) : []
  if (!list.length) return 'general'
  return [...new Set(list)].sort().join('|')
}

export function guessProblemType(text) {
  const lower = String(text || '').toLowerCase()
  let best = { type: 'other', hits: 0, weight: 0 }
  for (const type of PROBLEM_TYPES) {
    const words = TYPE_KEYWORDS[type]
    if (!words) continue
    const matched = words.filter((w) => lower.includes(w.toLowerCase()))
    // 同分时优先「更长、更具体」的关键词：起名 > 库
    const weight = matched.reduce((sum, w) => sum + w.length, 0)
    if (
      matched.length > best.hits ||
      (matched.length === best.hits && matched.length > 0 && weight > best.weight)
    ) {
      best = { type, hits: matched.length, weight }
    }
  }
  return best
}

/**
 * @returns {{verdict:'yes'|'maybe'|'no', reason:string, hasCode:boolean,
 *            objectiveHits:string[], subjectiveHits:string[], problemType:string,
 *            situationTags:string[], bucket:string}}
 */
export function detectIntent(text) {
  const src = String(text || '')
  const lower = src.toLowerCase()
  const hasCode = /```/.test(src)
  const objectiveHits = OBJECTIVE_MARKERS.filter((w) => lower.includes(w.toLowerCase()))
  const subjectiveHits = SUBJECTIVE_CUES.filter((w) => src.includes(w))
  const guessed = guessProblemType(src)
  const tags = situationTags(src)

  let verdict = 'no'
  let reason = 'no_signal'
  if (hasCode || objectiveHits.length >= 2) {
    verdict = 'no'
    reason = hasCode ? 'contains_code' : 'objective_markers'
  } else if (objectiveHits.length === 1) {
    verdict = 'no'
    reason = 'objective_marker'
  } else if (subjectiveHits.length >= 1 && guessed.type !== 'other') {
    verdict = 'yes'
    reason = 'subjective_cue_with_type'
  } else if (subjectiveHits.length >= 2) {
    verdict = 'yes'
    reason = 'subjective_cues'
  } else if (subjectiveHits.length === 1) {
    verdict = 'maybe'
    reason = 'single_weak_cue'
  }

  return {
    verdict,
    reason,
    hasCode,
    objectiveHits,
    subjectiveHits,
    problemType: guessed.type,
    situationTags: tags,
    bucket: situationBucket(tags),
  }
}
