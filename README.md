# acw

固定账号的 ChatGPT 原生 CLI：向**普通临时会话**提问、联网搜索，并把完成的问答归档到本地库。

复用本机 ChatGPT App 的官方认证与设备证明组件；不发起 Codex 模型回合，也不修改 App 登录。

## 平台前提

| 平台 | 状态 |
|---|---|
| macOS | 已验证 |
| Windows | 未验证 |
| Linux | 未验证 |

**为什么目前只有 macOS**：本工具依赖 ChatGPT.app 内的官方组件做设备证明：

- `/Applications/ChatGPT.app/Contents/Resources/native/devicecheck.node`
- `/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node`

这是架构前提，不是配置项。Windows / Linux 缺少这些组件，当前无法运行。设备证明由 Apple 正常生成，不做伪造，也不修改 App。本工具使用 App 内部接口，仅针对当前安装版本验收；App 更新或服务端接口变化后需要复测。

## 安装

需要 Node >= 20、`uv`、`curl-cffi==0.16.3`（首次运行由 uv 自动拉取）。

```sh
git clone git@github.com:cjxh21/agent-chatgpt-web.git
cd agent-chatgpt-web
ln -s "$PWD/acw" ~/.local/bin/acw
```

## 首次配置

需要一个 **Codex 标准格式的 auth.json**。最常见来源是 `~/.codex/auth.json`
（在终端跑一次 `codex login` 就会生成）。

```sh
acw setup --auth ~/.codex/auth.json --library ~/Documents/ChatGPT/websync
```

setup 会校验身份（邮箱、邮箱已验证、账号 ID、有效期）后导入，并按需创建配置。
校验不通过会明确报错，不会写入无效凭据。

配置完成后随时自检：

```sh
acw doctor
```

`configured: true` 表示可以正常使用。

## 共享凭据库 ~/.gptaccounts

凭据与配置存放在 **~/.gptaccounts/**，与项目目录隔离，可被其他 Codex 系工具共享：

```
~/.gptaccounts/
├── config.json                      # 全局配置，0600
├── credentials/
│   ├── <email>.json                 # Codex 标准格式，0600
│   └── .bak/                        # 刷新前的自动备份
└── ...
```

凭据使用 **Codex 标准格式**，与 `~/.codex/auth.json` 完全一致，其他 Codex 系工具可以直接读取。

## 多账号 / 多库

配置按 profile 建模，每个 profile 拥有独立账号与存储库：

```json
{
  "schema": "gptaccounts/v1",
  "activeProfile": "default",
  "profiles": {
    "default": { "account": "you@example.com", "library": "~/Documents/ChatGPT/websync", "embdDb": "chatgpt" },
    "work":    { "account": "work@example.com", "library": "~/Documents/ChatGPT/work", "embdDb": "chatgpt-work" }
  }
}
```

```sh
acw setup --auth ~/work-auth.json --library ~/Documents/ChatGPT/work --profile work
acw profiles                       # 列出全部 profile
acw ask --profile work ...         # 临时切换账号与库
```

## 使用

```sh
acw doctor
acw account
acw models
acw ask --temporary --search --prompt-file /path/question.txt --output /path/result.json
acw status --job /path/job.json --content
acw list --limit 20
acw backup
```

长任务用后台提交，避免调用方超时：

```sh
acw ask --temporary --async --search --prompt-file /path/question.txt
acw status --job <library>/native-jobs/<id>.json
```

`queued` 只表示本地已接受；`complete: true` 且 `phase: done` 才代表完整回答与归档成功。

## 共享方

`~/.gptaccounts` 现在是本机 **ChatGPT 原生登录态的唯一来源**，以下三处都从它读取，
不再各自保存副本：

| 使用方 | 读取方式 |
|---|---|
| `acw` / `gptweb` skill | 默认 profile 账号；临近过期自动刷新并写回本库 |
| `codex-imagegen` skill | 一次性 `CODEX_HOME` + `auth.json` 软链到本库文件 |
| DSH `dsh-codex-workbench` | 账号邮箱登记于本库时直接读取；额度查询同样优先读本库 |

给 Codex 类工具的说明：本库凭据是官方 Codex client 签发的授权（`scp` 为 openid/profile/email/offline_access），
**不能**当作注入的 bearer token 喂给自定义 provider —— 那条路在 `turn/start` 会返回
`401 Missing scopes: api.responses.write`。正确用法是像官方登录一样，让 codex 自己读一个
指向本库文件的 `auth.json`；此时刷新会自动写回本库。

反向约束仍然成立：`acw` 只写 `~/.gptaccounts`，**绝不**修改 `~/.codex` 或 CC Switch。

## Token 刷新

access_token 临近过期（5 分钟内）时自动用 refresh_token 换取新 token，
并**整体写回 ~/.gptaccounts**（写前备份到 `.bak/`）。

- 只写自己的共享库，**绝不**修改 `~/.codex` 或 CC Switch
- 刷新后校验身份与账号未变，防止串号
- 刷新失败保留原凭据，返回明确错误码
- refresh_token 可重复使用，多工具共享同一份不会互相踢下线

## 安全边界

- 不复制 token 到命令行、日志或浏览器存储
- 账号身份校验不通过时直接停止，不回退其他账号
- 凭据与配置默认 0600，目录 0700，且被 `.gitignore` 排除

## 测试

```sh
npm test
```