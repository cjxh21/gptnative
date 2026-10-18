# acw 原生调用说明

这份文档讲实现细节与边界；上手用法看 [README.md](README.md)，agent 调用规则看 [SKILL.md](skills/gptweb/SKILL.md)。

## 认证链路

凭据来自 **`~/.gptaccounts/`** 共享库，不依赖任何特定项目的内部结构。解析顺序：

1. `ACW_ACCOUNT` 环境变量（显式指定邮箱）
2. 配置里 `activeProfile` 指向的 `account`
3. 都没有则报 `NOT_CONFIGURED`（不做猜测）

CLI 与 Python 传输层各自独立校验，规则相同：

- `auth_mode` 必须是 `chatgpt`
- `id_token` 的 `email` 存在且 `email_verified === true`
- `access_token` 内嵌的 `chatgpt_account_id` / `chatgpt_user_id` 必须存在
- 两处 `account_id` 必须一致
- 有效期在 30 秒以上，否则先走刷新

任何一项不符直接报错，**不回退其他账号**。

## 设备证明

发问前需要用 ChatGPT App 自带的官方组件生成 Apple 设备证明：

```
/Applications/ChatGPT.app/Contents/Resources/native/devicecheck.node
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node
```

证明由 Apple 正常生成，不伪造、不修改 App。这是 **macOS 专属** 的架构前提，
所以 Windows / Linux 当前不可用；这属于依赖限制，不是配置项。

请求头沿用 App 的真实字段（`x-openai-web-frontend: codex_webview` 等），
用于让服务端按官方客户端处理。

## Token 刷新

`access_token` 剩余寿命低于 5 分钟时，用 `refresh_token` 向 `auth.openai.com/oauth/token` 换新，
并整体写回 `~/.gptaccounts/credentials/<email>.json`：

- 写回前备份到 `credentials/.bak/`
- 刷新后校验账号 ID 与邮箱未变（防串号），变了就拒绝写回
- 刷新失败保留原凭据，返回明确错误码
- **只写自己的共享库**，绝不修改 `~/.codex` 或 CC Switch

实测依据：`refresh_token` 可重复使用，不会一次性作废，因此多个工具共享同一份不会互相踢下线。

## 登录

`acw login` 封装 `codex login --device-auth`：

- 用临时 `CODEX_HOME` 隔离写入，不碰用户已有的 `~/.codex` 登录
- 解析输出里的一次性验证码与链接转发给用户
- 登录完成后读取临时目录的 `auth.json`，校验身份再存入共享库
- 临时目录用完即删

codex 输出带 ANSI 样式，解析前会先剥离控制码；验证码段长不固定，用宽松匹配。

## 后台任务

`ask --async` 会启动一个 detach 的 worker，调用方超时退出不影响生成。
job 文件落在当前 profile 的 library 下 `native-jobs/`，状态机为
`queued → initializing → streaming → done/failed/interrupted/timeout`。

只有 `complete: true` 且 `phase: done` 才算完整回答与归档成功。

不确定是否已发送的任务**不自动重发**；已完成的用 `archive --input` 补存。

## 依赖

- 本机 Node >= 20
- `uv` + `curl-cffi==0.16.3`（首次运行自动拉取）
- macOS + ChatGPT App（设备证明）
- codex CLI（仅 `login` 子命令需要）

## 验收边界

针对 ChatGPT App `26.1007.71326` 验收。App 更新或服务端接口变化后需要复测。
未做多路并发压力验收，不承诺任意 n 路并发。
