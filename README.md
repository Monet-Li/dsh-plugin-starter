# dsh-self-taught

一个 DeepSeek Harness 插件：**主观问题先采样、再给方向、最后记住你的选择**。

它不是"AI 帮你做决定"，而是把"没有标准答案的问题"从"模型凭喜好直给"改成一条可审计的流程：

1. 先查你的历史偏好（有就按偏好给，并标注可例外）；
2. 没有就联网采样当前情境下的主流做法，聚成 2~3 个方向；
3. 每个方向必须带案例、来源、代价、适用情境；
4. 你选定后记下来，同一方向出现多次会自动升级为强偏好——**等级由代码算，不由模型自报**。

---

## 为什么需要它

问"帮我选落地页配色"，普通回答是第一句话就替你拍板，而那句话反映的是模型的训练分布，不是你这个项目的情境。问第二次，它可能给出相反的答案，因为没有任何东西被记住。

这个插件补的正是这两块：**采样**（外部证据）和**记忆**（你的选择）。

## 能力

| 工具 | 作用 |
| --- | --- |
| `pref_lookup` | 查某类问题在某情境下的历史偏好，返回等级、是否可例外、可直接引用的一句话 |
| `pref_sample` | 联网采样：构造查询 → 搜索 → 去重 → 域名统计 → 判级 `strong/weak/none` |
| `pref_record` | 记录你的选择（含理由与情境），由代码计算等级并写库 |

外加一段常驻系统提示，规定"主观 / 客观"的分流规则和呈现格式。

## 三个设计原则

**一、没有证据就不许谈人气。** 采样判为 `none` 时（搜不到、搜索失败、结果全来自一个站），提示词强制回答改成"这个情境下我没有找到可靠共识（原因：…）"，然后给按原则推导的候选并逐个标"推导，非流行度证据"。"主流 / 大多数人 / 最流行 / 大家都 / 公认"这些词在没有来源时是硬禁止，`lib/prompts.js#auditAnswer` 会扫出来。

**二、等级是算出来的。** 同一方向在同一情境出现 1 次 = `weak`，2 次 = `strong`，3 次 = `global`；跨 3 个情境桶升一级；说"以后都这样"直接 `global`；改选别的方向会把旧方向降级并记下 `downgraded_from`；超过 90 天没再出现自动降一级并标 `stale`。`other` 类型永不升级为全局，避免碎片标签污染。

**三、方向的数量和证据受约束。** 最多 3 个方向，每个方向要么挂 ≥2 个不同域名的真实来源，要么显式标 `derived: true`。`validateDirections()` 会在记录时校验，编造来源会被记进 `audit`。

## 安装

本仓库同时是一个 npm 包和一份 Loader 补丁。

**A. 从本地目录装（开发时用）**

对 Agent 说：「用 `plugin_manager` 安装这个 bundle：`<本目录绝对路径>`」。Agent 会调 `plugin_manager` / `action: install_bundle` / `target` 传绝对路径，会要一次审批（安装会写 `%USERPROFILE%\.dsh\profiles\desktop`）。

- 返回 `applied` → 已生效；`restart-required` → 重启 App。
- **不要**手写 profile 里的 `package.json` / `cordis.patch.yml`，**不要**在那个目录跑 pnpm。

**B. 从 npm 装（发布后）**

```bash
npx dsh plugin add dsh-self-taught
```

## 配置

装好后在插件配置里可改（都有默认值，不配也能跑）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `mode` | `auto` | `auto` 全开；`manual` 只注册工具不注入提示；`off` 什么都不注册 |
| `dbPath` | `<DSH_HOME>/plugin-data/dsh-self-taught/prefs.db` | 换成带盘的路径可以跨机器同步 |
| `maxDirections` | `3` | 最多给几个方向 |
| `sampleMaxResults` | `10` | 每次查询取几条 |
| `staleDays` | `90` | 多久不看就算陈旧，降一级 |
| `exceptionWindowDays` | `30` | 这么多天内有反例 → 标"可例外" |

## 数据

SQLite（`node:sqlite` 内置驱动，无原生依赖），WAL 模式，四张表：

- `observations` —— 每次决策一行，**唯一真相源**（问题、类型、情境标签与桶、采样强度、选了什么、理由、等级、置信度）
- `sampling_runs` —— 每次采样一行（查询语句、来源数、域名数、强度、原始 sources），可审计
- `preferences` —— 派生表，随时可由 `observations` 重建
- `v_...` 索引：`(problem_type, situation_bucket, created_at)`

置信度是确定性公式，不是模型自报：

```
0.40*证据强度 + 0.20*新鲜度 + 0.15*域名多样性
+ 0.25*(方向是否有来源支撑 ? 1 : 0.5) + (显式全局 ? 0.15 : 0)
```

## 开发

```bash
node --test --test-isolation=none tests/   # 47 个用例
node scripts/smoke.mjs                     # 用假 ctx 跑一遍 apply()，不碰真 profile
```

测试覆盖：分类判定、升级/降级状态机、采样统计与三档判级、采样失败兜底、方向来源校验、提示词自检、工具注册形状。

> `--test-isolation=none` 是为了在受限沙箱里跑（默认每个文件起子进程，会被拦）。老版本 Node 不认这个 flag 时，直接 `node tests/xxx.test.js` 逐文件跑。

结构：

```
index.js              apply(ctx, config)：注册提示段 + 三个工具 + 清理
lib/config.js         配置默认值与归一化
lib/classify.js       规则召回：主观/客观、类型、情境标签（纯函数）
lib/escalate.js       升级/降级状态机 + lookup（纯函数）
lib/store.js          SQLite 读写（node:sqlite）
lib/sample.js         查询构造 / 去重 / 统计 / 判级 / 方向校验（注入 search，可离线测）
lib/prompts.js        常驻提示段 + 人气断言自检
lib/confidence.js     置信度公式
lib/tools.js          三个工具的完整定义
```

## 已知限制

- **分类不是精确的。** 规则层只看关键词，最终靠主模型按提示词裁定；宁可漏触发，也不要干扰客观问题。代码里有客观否决词优先的逻辑（带代码块一律判客观）。
- **"限定时效"是弱保证。** `web.search` 的请求只支持 `query` 和 `maxResults`，没有时间过滤参数；时效只能靠查询词 + 返回结果的 `publishedAt` 事后统计（`datedShare`）。
- **采样质量取决于搜索源。** 中文长尾话题容易只搜到单一站点，这时会被判成 `none` 而不是硬凑共识。
- **群组偏好没有做。** 现在是"你自己的偏好"，没有多人聚合。

## 发布到 GitHub

本目录是干净的仓库根目录（`.gitignore`、`.gitattributes`、`.github/workflows/publish.yml` 都在，分支 `main`）。

在 <https://github.com/new> 建空仓库 `dsh-self-taught`，**不要勾** README / .gitignore / license（会和本地提交冲突），然后：

```bash
git remote add origin https://github.com/<你的用户名>/dsh-self-taught.git
git push -u origin main
```

发 npm 前把 `"name"` 改成 `@<你的npm用户名>/dsh-self-taught`，然后 `npm publish --access public`。

## License

MIT，见 [LICENSE](./LICENSE)。
