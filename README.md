# dsh-self-taught

一个 DeepSeek Harness 插件。当前是**可运行的骨架**：在 Web UI 输入框下方的停靠区（`conversation.composer.dock`）显示一行问候，用来验证「安装 → 生效 → 迭代」这条链路通了，再往上长真正的功能。

---

## 结构

一个 DSH 插件 = **一个普通 npm 包** + **一份 Loader 补丁**。纯 ESM，无需构建步骤。

| 文件 | 作用 |
| --- | --- |
| `package.json` | 包清单。`dsh.bundle.patch` 指向补丁；`dsh.client` 声明浏览器半边的平台与依赖注入 |
| `cordis.patch.yml` | Loader 补丁：`insert` 一行插件条目，`name` 指回本包 |
| `index.js` | Host 半边（Node 侧）。纯 UI 插件可以是空的 `apply() {}` |
| `client.js` | 浏览器半边。注册到 `window.__ModuleLoader__`，**factory 的 id 必须等于包名** |
| `locale/en.json`、`locale/zh.json` | 插件列表里显示的标题/描述（`meta.title`、`meta.description`） |
| `icon.svg` | 插件列表图标，必须真实可渲染，≤ 256 KiB |
| `LICENSE`、`README.md` | 仓库门面 |

---

## 一、装到本地

1. 把本目录放到任意位置（当前在 `F:\dsk-work\dsh-self-taught`）。
2. 对 Agent 说：**「用 plugin_manager 安装这个 bundle：<该目录的绝对路径>」**。
   - Agent 调 `plugin_manager`，`action: install_bundle`，`target` 传**绝对路径**。
   - 会要一次审批（安装会写入 `C:\Users\<你>\.dsh\profiles\desktop`）。
3. 读返回里的 `application`：
   - `applied` → 已生效，刷新页面即可看到。
   - `restart-required` → 重启 DeepSeek Harness。
   - `warnings` 非空 → 逐条读，通常是 `exports` 或 `files` 漏了文件。

**不要**手写 `%USERPROFILE%\.dsh\profiles\desktop\package.json` 或 `cordis.patch.yml`，**不要**在那个目录跑 pnpm —— `install_bundle` 会做完这些，手改会和它打架。

## 二、改 → 重装 → 验证

- 本地目录安装是**链接**语义：只改 `locale/`、`icon.svg`，重载页面可能就看到。
- 改 `client.js` / `index.js`（JS 本体）**必须重启 App** —— 已安装的包要换新的模块代际。
- 验证不需要翻日志：
  - Agent 调 `cordis_inspect_query`（Client / `Slots.listSubTree`，root 传 `conversation.composer.dock`），你的 `id` 出现在 `occupants` 里；
  - 页面：输入框下方多了一行 `👋 Hello from my plugin`；
  - 插件列表：标题、描述、图标是你写的，不是模板兜底图。

## 三、发布到 GitHub

本目录已经是干净的仓库根目录（`.gitignore`、`.gitattributes` 齐了，分支 `main`）。

**先在 <https://github.com/new> 建空仓库，名字填 `dsh-self-taught`，Public，不要勾 README / .gitignore / license**（勾了会和本地提交冲突）。

然后在仓库根目录执行：

```bash
git remote add origin https://github.com/<你的用户名>/dsh-self-taught.git
git push -u origin main
```

第一次会弹浏览器授权（Git Credential Manager），登录过 GitHub 点一下即可。

> 若第 1 步误勾了 README：`git pull --rebase origin main` 后再 push。

之后就是常规流程：改 → `git commit` → `git push`。

## 四、让别人也能装（可选）

**A. 只给自己/朋友** —— clone 下来，按第一步用绝对路径安装，最简单。

**B. 发到 npm** —— 别人用包名一条命令装。改两处：

```jsonc
"name": "@<你的npm用户名>/dsh-self-taught",
"private": false,
```

```bash
npm login
npm publish --access public
```

> `@local/...` 是占位 scope，发不出去，必须换成自己的。GitHub Actions 的自动发布在 `.github/workflows/publish.yml`，用前填 `NPM_TOKEN`。

## 五、往上长功能

骨架跑通后，按需求挑扩展点：

- **给 Agent 加工具** → `index.js` 里 `export const inject = ['tools']`，在 `apply(ctx, config)` 内注册；
- **加面板 / 页面** → 换 Client 侧注册的 Slot，不要往 `document.body` 上再挂一个应用；
- **接 MCP 服务器** → 不用写 JS，用「配置型 bundle」更省。

API 一律以 `cordis_inspect_query` 查到的当前实现为准（`Service` / `Event` / `Config` / `Tool` / `Slots`），别照抄网上的旧示例。

**改名的 5 个位置**（改插件名时必须同步）：

| 位置 | 说明 |
| --- | --- |
| `package.json` → `name` | 包名 |
| `client.js` → `load({ id })` | 与包名**完全一致** |
| `cordis.patch.yml` → 条目 `id` 与 `name` | `id` 自取，别撞内置；`name` 同包名 |
| `locale/*.json` → `meta.title` / `meta.description` | 插件列表显示的名字与说明 |
| `icon.svg` | 自己的图标（原创或有授权） |

## 常见坑

- **改了 `client.js` 没变化**：不是热更新，重启 App。
- **列表里是默认图标 / 模板文案**：`files` 没含 `locale/*.json` 或 `icon.svg`，或 `exports` 漏了 `./icon`。
- **页面不出现插件**：`load({ id })` 和包名不一致，或 `dsh.client.inject` 少写了宿主 UI 包。
- **`overridden`**：有更高优先级的层盖住了这一行。
- **别手写 `%USERPROFILE%\.dsh\` 里的东西**：升级/重装会丢。

## License

MIT，见 [LICENSE](./LICENSE)。
