# dsh-self-taught · 第一步交付（只设计，不写实现）

本文件回答你要的 6 件事。所有 API 签名都是**在你这台机器上实测查出来的**（`cordis_inspect` 查当前运行的 Host），不是凭记忆。

---

## 1. 真实存在的 hook 与工具签名

### 1.1 先说语言/运行时（这条影响你填的第一行）

**DSH 插件不是独立进程，它在 DSH 宿主进程里跑，是 Node ESM 模块。Python 3.11 这条路不存在。**

- 实测：`node v26.13.0`
- 我已跑通 `node:sqlite`（Node 22.5+ 内置）：建表、事务、聚合查询都正常 → **SQLite 用内置驱动，零 npm 依赖、不用编译原生模块**

```
node v26.13.0 [{"k":"a","c":2}]     ← 实测输出：SELECT k, COUNT(*) FROM t GROUP BY k
```

> 如果你坚持要 Python，那就不是"dsh 插件"而是外挂服务（插件只做 http 转发），复杂度和失败面都会翻倍。**默认按 Node 走。**

### 1.2 你猜的 hook 名都不存在

`on_user_message` / `before_model_call` / `after_model_call` 这三个名字在 DSH 里没有。真实的事件表里，与我们相关的是：

| 事件名 | 模式 | 签名（原文） |
|---|---|---|
| `agent/pre-step` | waterfall | `'agent/pre-step'(this: Scoped<Agent>, payload: { agent: Agent; messages: UserMessage[]; turn: number; step: number; signal: AbortSignal }, next: () => Promise<PreStepDecision>): Promise<PreStepDecision>` |
| `agent/request` | waterfall | `'agent/request'(this: Scoped<Agent>, payload: { agent: Agent; turn: number; step: number; signal: AbortSignal }, next: () => Promise<LlmCallConfig>): Promise<LlmCallConfig>` |
| `agent/turn-stopping` | serial | `'agent/turn-stopping'(this: Scoped<Agent>, payload: { agent: Agent; turn: number; signal: AbortSignal }): Promise<void> \| void` |
| `system-prompt/assemble` | waterfall | `'system-prompt/assemble'(this: Scoped<SystemPrompt>, assembly: PromptAssembly, context: AssembleContext, next: () => Promise<PromptAssembly>): Promise<PromptAssembly>` |
| `tools/pre-execute` | waterfall | `'tools/pre-execute'(this: Scoped<ToolRuntime>, exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision>` |
| `tools/post-execute` | waterfall | `'tools/post-execute'(this: Scoped<ToolRuntime>, exec: ToolExecution, result: Readonly<ToolExecutionResult>, next: () => Promise<PostToolDecision>): Promise<PostToolDecision>` |
| `session/event` | emit | `'session/event'(this: Scoped<Session>, session: Session, event: SessionEvent): void` |
| `agent/created` | serial | `'agent/created'(this: Scoped<Agent>, payload: { agent: Agent; source: SessionStartSource; signal?: AbortSignal }): undefined \| Promise<undefined>` |

关键类型：

```ts
type PreStepDecision = { kind: 'reject' } | { kind: 'enter'; messages: UserMessage[]; startsRequestSeries?: true }
```

**含义**：`agent/pre-step` = "用户消息进入下一 step 之前"，是 `before_model_call` 的等价物；它可以**替换/追加进入模型的消息**，但**不能拦截并直接回答**（只能 reject 掉这一步）。

### 1.3 我们要用的服务（原文签名）

```ts
// 提示词注入
ctx.systemPrompt.section(section: PromptSection): () => void
ctx.systemPrompt.context(context: PromptContext): () => void
ctx.systemPrompt.tools(provider: (context: AssembleContext) => ToolProviderResult): () => void
ctx.systemPrompt.assemble(context?: AssembleContext): Promise<PromptAssembly>

interface PromptSection {
  readonly name: string
  readonly order: number
  readonly text: string | ((context: AssembleContext) => string)
  readonly interpolate?: boolean
  readonly complete?: boolean
}
interface PromptContext {
  readonly name: string; readonly order: number
  readonly text: string | ((context: AssembleContext) => string)
  readonly interpolate?: boolean; readonly required?: boolean
}
interface AssembleContext { scope?: ScopeKey; signal?: AbortSignal }   // ScopeKey = object

// 工具注册
ctx.tools.register(definition: ToolDefinition): () => void
ctx.tools.guard(guard: ToolGuard): () => void          // 返回 string 即拒绝
ctx.tools.restrict(filter: ToolRestriction): () => void

interface ToolDefinition extends ToolSchema {
  readonly output: ToolOutputDefinition
  execute(args: unknown, exec: ToolRunContext): Promise<unknown>
  timeoutMs?: number
  isConcurrencySafe?(args: unknown): boolean
}
interface ToolSchema { deferLoading?: true; name: string; description: string; parameters: Record<string, unknown> }
interface ToolOutputDefinition {
  readonly schema: JsonSchemaNode
  render(args: unknown, value: JsonValue): ContentBlock[]
  presentationMeta?(args: unknown, value: JsonValue): JsonValue
}

// 联网
ctx.web.search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult>
ctx.web.fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult>

interface WebSearchRequest { readonly query: string; readonly maxResults?: number }
interface WebSearchResult { readonly content?: string; readonly sources: readonly WebSearchSource[]; readonly truncated: boolean }
interface WebSearchSource { readonly url: string; readonly title?: string; readonly snippet?: string; readonly publishedAt?: string }
interface WebFetchRequest { readonly url: string }
interface WebFetchResult { readonly url: string; readonly statusCode: number; readonly body: { kind: 'html' | 'text'; content: string }; readonly truncated: boolean }

// 其他
ctx.commands.register(definition: CommandDefinition): () => void
ctx.skills.register(skill: SkillRegistration): () => void
```

**注意**：`WebSearchRequest` 只有 `query` 和 `maxResults`，**没有时间过滤参数**。这是硬限制，"限定时效"只能靠查询词 + 结果里的 `publishedAt` 事后过滤，属弱保证。

### 1.4 "可用工具"的现实

| 你写的 | 实际情况 |
|---|---|
| `web_search` | ✅ 存在。模型侧工具名 `web_search`；插件侧等价调用 `ctx.web.search({query, maxResults})`，复用**你已配置好的搜索 provider**，不需要额外 key |
| `fetch_url` | ❌ 没有这个名字。模型侧叫 `web_fetch`；插件侧 `ctx.web.fetch({url})`。**fetch provider 是否已注册我没验证**（第一版可以完全不用它：摘要够用） |
| 缺什么 | 缺"可编程调用小模型/便宜模型做分类"的现成接口 —— 只有底层 `llm` 运行时与 `'llm/stream'` 瀑布。**所以第一版不做模型分类调用**（理由见 §4） |

---

## 2. 插件架构图

### 2.1 数据流

```mermaid
flowchart TD
    U[用户提问] --> P[agent/pre-step<br/>只读扫描 · 不算不写]
    P -->|"objective 命中"| N[不注入任何东西<br/>走原有流程]
    P -->|"subjective 候选 / 存疑"| F[标记本轮 turn<br/>agentId+turn 内存表]
    F --> A[systemPrompt.section<br/>text(ctx) 按标记决定是否输出]
    N --> A
    A --> M[主模型 step]
    M -->|"判定主观"| L[pref_lookup]
    L --> DB[(SQLite<br/>preferences)]
    L -->|无强偏好| S[pref_sample]
    S --> W[ctx.web.search ×1..3]
    W --> S2[去重/域名聚合/时效过滤<br/>evidence_strength · consensus]
    S2 --> M2[模型聚类 2~3 方向]
    M2 --> R[呈现模板<br/>方向+案例+优点+代价+你更看重什么]
    R --> CH[用户选择]
    CH --> REC[pref_record]
    REC --> DB
    REC --> UP[确定性升级算法<br/>single/pattern/user_preference<br/>situational/global]
    UP --> M3[把新等级照实告诉用户]
```

### 2.2 模块划分

| 模块 | 文件 | 职责 | 依赖 |
|---|---|---|---|
| 入口/装配 | `index.js` | `apply(ctx, config)`：读配置、开库、注册提示段 / 工具 / 命令 /（可选）pre-step 探针 | 其余全部 |
| 配置 | `lib/config.js` | 读 `self-taught.config.json` + `export const Config` 默认值；`mode: auto\|manual\|off` | fs |
| 判定 | `lib/classify.js` | 纯函数：文本 → `{verdict, cues, veto, score}`；主观/客观线索、problem_type 候选 | 无 |
| 存储 | `lib/store.js` | SQLite 打开/迁移/写 observation/重建 preferences/查询；WAL；写队列 | `node:sqlite` |
| 采样 | `lib/sample.js` | 查询构造、调用 `ctx.web.search`、去重、统计、`evidence_strength`、`consensus` | `ctx.web` |
| 升级 | `lib/escalate.js` | 纯函数：records → level / scope / confidence | 无 |
| 提示词 | `lib/prompts.js` | 常驻段全文、呈现模板、skill 正文 | 无 |
| 工具 | `lib/tools/*.js` | `pref_lookup` / `pref_sample` / `pref_record` 三个定义 | store, sample, escalate |
| 命令 | `lib/commands.js` | `/prefs`、`/prefs forget`、`/prefs why` | store |
| Skill | `skills/subjective-preference/SKILL.md` | 分类细则、聚类标准、正反例（按需加载，省 token） | — |
| 客户端（P4 可选） | `client.js` | dock 显示"已记录 N 条偏好" | — |

### 2.3 三种模式怎么落地（`auto / manual / off`）

| mode | pre-step 探针 | 常驻提示段 | 工具 |
|---|---|---|---|
| `auto`（默认） | 开：扫描用户消息，命中主观候选就标记本轮 | 开着；`text(ctx)` 看到标记 → 输出完整规则；没标记 → 输出 1 行极简提醒（约 40 token） | 一直可调用 |
| `manual` | 关 | 只在用户写 `/pref` 前缀或说"按偏好流程来"时，由命令置一个一次性开关 | 一直可调用（但模型被告知"未经要求不要主动采样"） |
| `off` | 关 | 完全不注册 | 不注册 |

> `manual` 的开关靠 `/pref on`、`/pref off` 命令改配置文件，不靠猜。

---

## 3. SQLite 表结构

文件：`<DSH_HOME>/plugin-data/dsh-self-taught/prefs.db`（可配置），`journal_mode=WAL`，`user_version` 做迁移。

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA user_version = 1;

-- ① 一次"主观问题决策" = 一行；这是唯一真相源
CREATE TABLE observations (
  id                 TEXT PRIMARY KEY,              -- r_<ulid>
  created_at         TEXT NOT NULL,                 -- ISO8601 带时区
  session_id         TEXT NOT NULL,
  turn               INTEGER,
  mode               TEXT NOT NULL,                 -- auto | manual
  question           TEXT NOT NULL,                 -- 用户原问题（≤1000 字）

  is_subjective      INTEGER NOT NULL,              -- 0/1（模型最终裁定）
  problem_type       TEXT NOT NULL,                 -- 固定枚举，见 §4.2
  problem_type_other TEXT,                          -- 仅 other 时填
  situation          TEXT NOT NULL,                 -- 情境原始描述（人话）
  situation_tags     TEXT NOT NULL,                 -- JSON 数组
  situation_bucket   TEXT NOT NULL,                 -- 归一化键，用于累计

  classification_by  TEXT NOT NULL,                 -- rules | model | user_forced
  classification_conf REAL NOT NULL,                -- 0..1 判定置信

  sampled_options    TEXT NOT NULL,                 -- JSON: [{key,name,example,pros,cons,sources[]}]
  sampling_run_id    TEXT,                          -- FK -> sampling_runs.id

  user_choice        TEXT,                          -- 方向 key；NULL = 用户没选/放弃
  user_choice_name   TEXT,
  user_reason        TEXT,                          -- 用户给的理由（原话或摘要）
  explicit_global    INTEGER NOT NULL DEFAULT 0,    -- 用户说"以后都这样"

  confidence         REAL NOT NULL,                 -- 0..1 作为"偏好证据"的可信度，见下
  level_after        TEXT,                          -- single_observation|pattern|user_preference
  scope_after        TEXT,                          -- situational|global_candidate|global
  same_direction_count INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX idx_obs_type_bucket ON observations(problem_type, situation_bucket, created_at);
CREATE INDEX idx_obs_direction   ON observations(problem_type, user_choice, created_at);
CREATE INDEX idx_obs_session     ON observations(session_id, created_at);

-- ② 采样运行（证据留档，可审计）
CREATE TABLE sampling_runs (
  id            TEXT PRIMARY KEY,
  created_at    TEXT NOT NULL,
  problem_type  TEXT NOT NULL,
  situation     TEXT NOT NULL,
  queries       TEXT NOT NULL,     -- JSON 数组
  source_count  INTEGER NOT NULL,
  domain_count  INTEGER NOT NULL,
  top_domain_share REAL NOT NULL,
  dated_share   REAL NOT NULL,
  strength      TEXT NOT NULL,     -- strong | weak | none
  consensus     INTEGER NOT NULL,  -- 0/1
  failure_reason TEXT,             -- WEB_PROVIDER_UNAVAILABLE / TOO_FEW_SOURCES / ...
  sources       TEXT NOT NULL      -- JSON: [{url,title,snippet,publishedAt,domain}]
);

-- ③ 派生：当前学到的偏好（可从 observations 重建）
CREATE TABLE preferences (
  id               TEXT PRIMARY KEY,
  problem_type     TEXT NOT NULL,
  situation_bucket TEXT NOT NULL,
  direction_key    TEXT NOT NULL,
  direction_name   TEXT NOT NULL,
  level            TEXT NOT NULL,  -- single_observation | pattern | user_preference
  scope            TEXT NOT NULL,  -- situational | global_candidate | global
  count            INTEGER NOT NULL,
  confidence       REAL NOT NULL,
  first_seen       TEXT NOT NULL,
  last_seen        TEXT NOT NULL,
  reasons          TEXT NOT NULL,  -- JSON 数组
  staleness_days   INTEGER NOT NULL DEFAULT 0,
  UNIQUE(problem_type, situation_bucket, direction_key)
);

-- ④ 全局视图（跨情境汇总），单独一张便于查询
CREATE TABLE preference_global (
  problem_type   TEXT NOT NULL,
  direction_key  TEXT NOT NULL,
  direction_name TEXT NOT NULL,
  buckets        INTEGER NOT NULL,     -- 覆盖多少个 situation_bucket
  total_count    INTEGER NOT NULL,
  confidence     REAL NOT NULL,
  last_seen      TEXT NOT NULL,
  PRIMARY KEY (problem_type, direction_key)
);

CREATE VIEW v_recent_observations AS
  SELECT o.created_at, o.problem_type, o.situation_bucket, o.user_choice_name,
         o.user_reason, o.confidence, o.level_after, o.scope_after
  FROM observations o
  WHERE o.user_choice IS NOT NULL
  ORDER BY o.created_at DESC;
```

### 3.1 你要的字段 → 表里的位置

| 你的字段 | 落点 |
|---|---|
| `problem_type` | `observations.problem_type`（枚举）+ `problem_type_other` |
| `situation` | `observations.situation`（人话）+ `situation_tags`（JSON）+ `situation_bucket`（归一化键） |
| `sampled_options` | `observations.sampled_options`（JSON 数组）+ `sampling_runs.sources`（原始来源） |
| `user_choice` | `observations.user_choice` / `user_choice_name` |
| `user_reason` | `observations.user_reason` |
| `confidence` | `observations.confidence`，公式见 §3.2 |
| `created_at` | `observations.created_at` |

### 3.2 `confidence` 的算法（确定性，模型改不了）

```
evidence_score  = { strong: 1.0, weak: 0.6, none: 0.2 }[strength]
recency_score   = clamp(1 - (days_since_latest_source / (recency_months*30)), 0, 1)
diversity_score = clamp(domain_count / max(source_count,1) , 0, 1)
explicit_bonus  = explicit_global ? 0.15 : 0

confidence = clamp(
  0.40*evidence_score + 0.20*recency_score + 0.15*diversity_score
  + 0.25*(model_agreed_with_evidence ? 1 : 0.5) + explicit_bonus,
  0, 1)
```

`model_agreed_with_evidence`：模型选的方向是否在 sources 里出现过（字符串匹配方向名/关键词），出现=1，纯原则推导=0.5。**效果**：无来源的选择 confidence ≤ 0.55，`pref_lookup` 不会把它当强偏好。

---

## 4. 主观判定 + problem_type 分类策略

### 4.1 结论：**规则召回 + 主模型裁定，不引入小模型**

三层结构，各管一段：

| 层 | 在哪 | 做什么 | 失败后果 |
|---|---|---|---|
| L1 规则（确定性） | `agent/pre-step` + `lib/classify.js` | 只判断"这段输入**可能**是主观问题"：客观否决词优先（报错/堆栈/算法/事实/日期/换算/API 用法/语法），主观线索词加权（审美/风格/取舍/要不要/更好看/更舒服/选哪个） | 只影响**要不要注入提示**，不影响答案；误判代价 ≈ 几十 token |
| L2 主模型（语义） | 常驻提示段 | 真正裁定 is_subjective、给出 `problem_type` + `situation_tags` | 判错=走错流程，但工具调用 schema 会挡（枚举校验） |
| L3 工具校验（确定性） | `pref_record` / `pref_sample` 的 JSON Schema | `problem_type` 必须 ∈ 枚举；`situation_tags` 非空数组；`directions` 结构必须齐全 | 直接报参数错误，模型必须重填 |

**为什么不用小模型分类**：

1. **没有便宜接口**。DSH 里没有"给我一个 cheap model 分类"的现成服务，只能摸底层 `llm` 运行时 → 要么自己拼 provider 调用，要么走 `subagent`（贵、慢、异步）。为一行分类多一次网络请求 + 一次失败可能，不划算。
2. **信息不对称**。分类需要看用户历史偏好、当前项目上下文（"这个博客"指什么），小模型只拿到一句话，判得比主模型差。
3. **失败模式翻倍**。多一个模型调用就多一个超时/超限/格式错的分支要处理。
4. **真正需要确定性的地方不在"分类"，而在"计数与判定"** —— 那部分已经用纯代码（§3.2、§5.3）保证，不依赖模型。

规则层仍然必要：它决定 `auto` 模式**要不要注入提示段**，把 token 成本压在"疑似主观"的回合上。

### 4.2 `problem_type` 枚举（固定 8 + other）

`visual_style` · `copy_tone` · `tech_choice` · `product_tradeoff` · `workflow` · `naming` · `content_structure` · `lifestyle` · `other`

- 用 `other` 时必须填 `problem_type_other`，且 `other` 的偏好**永不升级为全局**（碎片标签不配当全局偏好）。
- 枚举写进工具的 `parameters.enum`，模型想瞎造就直接 schema 报错。

### 4.3 判定提示（进常驻段，模型可读）

```text
【是不是主观问题？三问，任一为否就不是】
1. 换一个合理的人来做，答案会不会不同？（会 → 主观）
2. 答案是否取决于用户的具体情境（场景/受众/预算/时效/禁忌）？（是 → 主观）
3. 答错了是"不合口味"还是"确实错了"？（确实错 → 不是主观，走正常流程）

客观否决（出现即不是主观问题，禁止调用 pref_*）：
报错/堆栈/异常、事实核验、数值计算、单位换算、API 用法、语法、性能数字、
"这个函数签名叫什么"、任何有唯一正确输出的问题。
```

---

## 5. 联网采样 → 聚类 → 呈现

### 5.1 采样（确定性代码，`lib/sample.js`）

```
输入: problem_type, situation_tags, question
1. 构造 1~3 条查询（不超 maxResults=8/条，可配）
   q1 = "<情境主词> <problem_type 同义词> 推荐 2025"
   q2 = "<情境主词> <problem_type 同义词> 趋势 优缺点 争议"
   q3 = "<question 里的方向候选词> 对比 好在哪里"
2. 逐条 ctx.web.search({query, maxResults})，并发跑但共享 signal；单条失败只记原因，不整体失败
3. 规范化 URL（去 utm_*/#/尾斜杠）→ 去重
4. 统计: source_count / domain_count / top_domain_share / dated_share(recency_months 内)
5. 判级:
   strong : n>=8 && d>=5 && top<=0.5 && dated>=0.5
   weak   : n>=4 && d>=3
   none   : 其余 或 provider 不可用 或 0 条
6. 落 sampling_runs 一行，返回 sources + stats + strength + consensus(= strength!=none)
```

失败分支必须带 `failure_reason` ∈ `{WEB_PROVIDER_UNAVAILABLE, QUERY_FAILED, TOO_FEW_SOURCES, SINGLE_DOMAIN_DOMINANT, NO_DATED_SOURCES}`。

### 5.2 聚类（模型的活，但给它骨架）

代码只给事实，不给结论：

```json
{ "sources": [ {url,title,snippet,publishedAt,domain} ],
  "by_domain": [{domain, count, sample_urls[]}],
  "stats": {source_count, domain_count, top_domain_share, dated_share},
  "strength": "strong" }
```

模型按固定规则聚类（写进 skill）：

1. 先按 `snippet` 里的**高频评价词/风格词**分桶，不按网站分桶；
2. 每个方向必须能被 ≥2 个**不同域名**的来源支持，否则降级为"个别观点"；
3. 方向数控制在 2~3；超过 3 个就合并相近项；
4. 每个方向必须挂 ≥1 个真实 URL；挂不上的写"（无来源，属原则推导）"；
5. `strength=none` 时**禁止**出现"主流/大多数人/最流行/大家都"——这是硬红线。

### 5.3 呈现模板（模型必须照这个结构输出）

```markdown
先给一句判断（不铺垫）：
「这类问题没有唯一答案，取决于 <关键情境变量>。我看到 <N> 个方向：」

### 方向 1：<名称>
- 代表案例：<具体案例/作品/配置> — [来源](url)（无来源则写：原则推导，无来源）
- 优点：<2 条，具体到效果>
- 代价：<2 条，具体到成本/风险/维护>
- 适合：<什么情境下选它>

### 方向 2 / 3：同上

### 你更看重什么？
<一个二选一问题，把选择权交回用户>
A. 更在意 <X> → 选方向 1
B. 更在意 <Y> → 选方向 2

---
（如果 strength = none / consensus = false，这段必须替换成：）
这个情境下我没有找到可靠共识（<reason 的人话版本>）。下面是按 <原则> 推的候选，
不是"大家都在用"：……
```

### 5.4 记录（用户选完之后）

模型调用：

```json
pref_record({
  "problem_type": "visual_style",
  "situation_tags": ["个人博客","深色背景","中文长文"],
  "question": "博客配色选暖色还是冷色",
  "directions": [{"key":"warm-minimal","name":"温暖极简","example":"…","pros":"…","cons":"…","source_urls":["…"]}],
  "choice": {"key":"warm-minimal","name":"温暖极简","user_reason":"想让人愿意多停留"},
  "evidence": {"source_count":12,"domain_count":8,"top_domain_share":0.25,"dated_share":0.75,"strength":"strong","consensus":true,"agreed_with_evidence":true},
  "explicit_global": false
})
→ 返回 { "level":"pattern", "count":2, "scope":"situational", "confidence":0.71,
         "message":"同一情境下这是第 2 次选温暖极简，已升级为 pattern。" }
```

模型必须把 `message` 照实说给用户，不能自己改写成"我记住了你的偏好"这种模糊话。

---

## 6. 我不确定、需要你确认的点

| # | 不确定的事 | 为什么重要 | 我的默认 |
|---|---|---|---|
| 1 | **语言**：确认只能用 Node/JS（Python 不行）？ | 决定整个技术栈，改起来等于重做 | Node ESM |
| 2 | **`AssembleContext.scope` 是不是 Agent 对象** | `auto` 模式"只对疑似主观的回合注入提示"依赖它；若不是，就只能常驻注入（每步约 +600 token） | 先按"是 agent"实现，P1 第一步就验证；不行则退化为常驻 + 40 token 极简版 |
| 3 | **SQLite 驱动**：`node:sqlite`（内置、零依赖、已验证）vs `better-sqlite3`（成熟但要编译原生模块） | 影响安装体验；DSH 插件装在你机器上，编译失败很烦 | `node:sqlite` |
| 4 | **DB 放哪**：`~/.dsh/plugin-data/`（跟机器走）vs 仓库目录（可 git 同步） | 换机器/多设备时的行为完全不同 | `~/.dsh/plugin-data/dsh-self-taught/prefs.db` |
| 5 | **`auto` 模式的 token 成本**：常驻 600 token/步 能不能接受？ | 你每轮对话都在付这个钱 | 能接受就常驻；不行就上 #2 的条件注入 |
| 6 | **`confidence` 口径**：§3.2 的公式是否合你意？还是你心里有别的定义（比如"置信 = 我有多确定这是你的稳定偏好"） | 它决定 `pref_lookup` 什么时候敢直给 | 用 §3.2 |
| 7 | **搜索 provider**：你当前配置里至少有一个能用的 search provider（因为 `web_search` 工具在），但 `fetch` provider 有没有我没验证 | 只影响"要不要抓正文"，不影响第一版 | 第一版只用 search 摘要，不用 fetch |
| 8 | **`/prefs` 命令 + `auto/manual/off`**：manual 的"on/off"用命令切换，可以吗？ | 你没指定切换方式 | `/pref on` `/pref off` `/pref mode auto` |
| 9 | **问题类型 8 类**是否符合你的实际提问习惯？ | 分类错了累计就归错桶 | 先 8 类，跑两周再改 |

---

**下一步**：你确认上面 9 条（或直接说"默认都行"），我进入编码。P1 我会先做一个**能跑通的最小闭环**：`pref_record` + `pref_lookup` + SQLite + 升级算法 + 一段可开关的提示词，然后用 fixture 数据把 7 条升级规则全测一遍，再动采样。
