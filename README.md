# dsh-plugin-hello

一个可以直接跑起来的 **DeepSeek Harness 插件模板**：在 Web UI 输入框下方的停靠区（`conversation.composer.dock`）显示一行问候。

把它改造成你自己的插件只需要改名 5 个地方（见文末），插件本体和 GitHub 流程都不变。

---

## 这是什么结构

一个 DSH 插件 = **一个普通 npm 包** + **一份 Loader 补丁**。没有构建步骤也可以，纯 ESM 即可。

| 文件 | 作用 |
| --- | --- |
| `package.json` | 包清单。`dsh.bundle.patch` 指向补丁；`dsh.client` 声明浏览器半边的平台与依赖注入 |
| `cordis.patch.yml` | Loader 补丁：`insert` 一行插件条目，`name` 指回本包 |
| `index.js` | Host 半边（Node 侧）。纯 UI 插件可以是空的 `apply() {}` |
| `client.js` | 浏览器半边。注册到 `window.__ModuleLoader__`，**factory 的 id 必须等于包名** |
| `locale/en.json`、`locale/zh.json` | 插件列表里显示的标题/描述（`meta.title`、`meta.description`），不发包也要有 |
| `icon.svg` | 插件列表图标。必须是真实可渲染的图片，≤ 256 KiB |
| `LICENSE`、`README.md` | 仓库门面，发 GitHub 时值得有 |

---

## 一、装到本地（开发时就是这一步循环）

1. 把这个目录整份复制到你想要的位置，例如 `F:\dsh-work\my-plugin`。
2. 对 Agent 说：**「用 plugin_manager 安装这个 bundle：<该目录的绝对路径>」**。
   - Agent 会调用 `plugin_manager`，`action: install_bundle`，`target` 传**绝对路径**。
   - 需要审批（安装会改 `C:\Users\<你>\.dsh\profiles\desktop`），点同意即可。
3. 看返回里的 `application` 字段：
   - `applied` → 已生效，刷新页面即可看到。
   - `restart-required` → 重启 DeepSeek Harness。
   - `warnings` 非空 → 逐条读，通常缺 export 或 `files` 没覆盖到文件。

**不要**自己手写 `%USERPROFILE%\.dsh\profiles\desktop\package.json` 或 `cordis.patch.yml`，也**不要**在那个目录里跑 pnpm —— `install_bundle` 会做完这些事，手改会和它打架。

## 二、改代码 → 重装 → 验证

- 本地目录安装是**链接**语义：改 `locale/`、`icon.svg` 之类资源，重载页面就可能看到。
- 改 `client.js` / `index.js`（JavaScript 本体）需要**重启 App** —— 已安装的包要换新的模块代际。
- 验证方式（都不用翻日志）：
  - Agent 调用 `cordis_inspect_query`（Client / `Slots.listSubTree`，root 传 `conversation.composer.dock`）能看到你的 `id` 出现在 `occupants` 里；
  - 直接看页面：输入框下方多了一行 👋 Hello from my plugin；
  - 插件列表里标题、描述、图标是否是你写的，不是模板兜底图。

## 三、发到 GitHub

本目录已经是一个干净的仓库根目录（`.gitignore` 已排除 `node_modules` 等）。

```bash
cd F:/dsh-work/my-plugin
git init
git add -A
git commit -m "feat: initial DSH plugin"
git branch -M main

# 先在 github.com 上建一个空仓库（不要勾 README/License），然后：
git remote add origin https://github.com/<你的用户名>/<仓库名>.git
git push -u origin main
```

如果装了 GitHub CLI，可以更省事：

```bash
winget install --id GitHub.cli        # 当前机器上还没有 gh
gh auth login
gh repo create <仓库名> --public --source . --push
```

之后就是普通 Git 流程：改 → `git commit` → `git push`。**GitHub 仓库和本地插件目录可以是同一个文件夹**，不需要两边各维护一份。

## 四、让别人也能装（可选）

有两条路，按需选：

**A. 只给自己/朋友用** —— 仓库 clone 下来，按第一步用绝对路径安装。最简单。

**B. 发到 npm** —— 别人用包名一条命令装：

```jsonc
// package.json 改两处
"name": "@<你的npm用户名>/dsh-plugin-hello",
"private": false,
```

```bash
npm login
npm publish --access public
```

> 注意 npm 上包名唯一：`@local/...` 这种 scope 是占位，发不出去，必须换成你自己的 scope。

## 五、改造成你自己的插件（改名清单）

| 位置 | 改成 |
| --- | --- |
| `package.json` → `name` | `@<scope>/dsh-plugin-xxx` |
| `client.js` → `load({ id: ... })` | 与上面**完全一致** |
| `cordis.patch.yml` → 条目的 `id` 与 `name` | `id` 自取（别撞内置 id），`name` 同包名 |
| `locale/*.json` → `meta.title` / `meta.description` | 你插件真实的名字和一句话说明 |
| `icon.svg` | 你自己的图标（原创或有授权） |

如果插件不止是装饰，还要提供能力，再决定扩展点：

- **给 Agent 加一个工具** → 在 `index.js` 里 `export const inject = ['tools']`，在 `apply` 内注册；
- **加一个设置面板 / 页面** → 换 Client 侧注册的 Slot，别自己往 `document.body` 上再挂一个应用；
- **接一个 MCP 服务器** → 不用写 JS，用「配置型 bundle」更省事。

具体 API 一律以 `cordis_inspect_query` 查到的当前实现为准（`Service` / `Event` / `Config` / `Tool` / `Slots`），不要照抄网上的旧示例。

## 常见坑

- **改了 `client.js` 没变化**：不是热更新，重启 App。
- **插件列表里是默认图标/模板文案**：`files` 没包含 `locale/*.json` 或 `icon.svg`，或 `exports` 漏了 `./icon`。
- **页面白屏 / 插件不出现**：`client.js` 里 factory 的 `id` 和包名不一致，或 `dsh.client.inject` 少写了要挂的 UI 包。
- **`install_bundle` 报 `overridden`**：有更高优先级的层盖住了这一行，检查 profile 里其他补丁。
- **别在 `%USERPROFILE%\.dsh\` 里手写文件**：那是 Harness 的领地，改动会随升级/重装丢失。

## License

MIT，见 [LICENSE](./LICENSE)。
