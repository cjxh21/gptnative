---
name: gptweb
description: 使用本机 acw 向 ChatGPT 普通临时会话提问、联网调研，并将完成问答及云端历史保存到配置的本地库与 embd 库。适用于用户要求调用 GPTWeb 或沿用这套调研与备份流程。
---

# GPTWeb：ChatGPT 原生直连

默认执行 `acw`，向普通 ChatGPT 临时会话提问、联网调研。CLI 不发起 Codex 模型回合；调用它的 agent 自身仍可能消耗所属平台额度。

## 第一步：自检配置

**每次开始前先跑这一条**，不要先读 CONFIG.md：

```sh
acw doctor
```

- 返回 `"configured": true` → 直接按下面「提问与取结果」使用。
- 返回 `"configured": false` → 读同目录的 [CONFIG.md](CONFIG.md)，按说明完成首次配置（导入 auth.json、选存储位置），再回到本流程。

用户要改账号、改存储位置、或加第二个账号/库时，同样先看 CONFIG.md 的对应小节；那是配置动作，不是日常使用。

## 提问与取结果

把完整问题用文件工具写入 UTF-8 文件，避免长文本 shell 转义。每次使用新临时聊天：

```sh
acw ask --temporary --async --search --prompt-file /绝对路径/question.txt --output /绝对路径/result.json
```

保存返回的 `job` 路径，随后查询本地状态：

```sh
acw status --job /绝对路径/native-jobs/任务ID.json
acw status --job /绝对路径/native-jobs/任务ID.json --content
```

注意：job 文件默认落在**当前 profile 的 library** 下的 `native-jobs/`，不是固定目录；以命令返回的 `job` 字段为准。

`queued` 只代表本地接受；`complete: true`、`phase: done` 才代表完整回答与自动归档成功。读取结果正文、`sources` 和搜索引用后，再向用户报告结论；提交成功不能当作调研完成。避免频繁轮询，可隔 15–30 秒查询。短问题可省略 `--async` 同步等待。

默认等待 20 分钟，`--timeout-ms 1800000` 可设 30 分钟，上限 60 分钟。输入本地上限 100000 个 Unicode 字符，服务端上下文限制另行适用。后台任务能在调用进程退出后继续；网络断流、限流、账号失效仍可能失败。

不在发问超时或结果不明后自动重复提交。检查任务的 `submitted`、错误和已收到内容。临时会话新连接补取实际可返回 404，不能承诺断线续传；`recover --job <路径>` 仅实验性读取原会话，不重新提问。已经完成但入库失败，用 `acw archive --input <结果或任务文件>` 补存，不重问模型。

多个后台任务各有独立文件和新临时会话；尚未进行同时生成压力验收，不承诺任意 n 路并发。默认逐个完成；用户明确要求并行时可有界提交，保留每个 job 与 output 的对应关系，遇到 429 停下，勿自动批量重发。


## 在其他设备首次使用

新设备只需一条命令，浏览器输入验证码即可完成登录并自动导入凭据：

```sh
acw login
```

命令会打印一个链接和一次性验证码（15 分钟有效）。让用户在浏览器打开链接、
登录自己的 ChatGPT 账号、输入验证码；完成后凭据自动落到 `~/.gptaccounts/` 正确位置，
无需手动寻找或复制 auth.json。

加第二个账号时指定 profile：

```sh
acw login --profile work --library ~/Documents/ChatGPT/work
```

完成后用 `acw doctor` 确认。

## 账号与存储位置

凭据与配置在 `~/.gptaccounts/`，与项目目录隔离，可被其他 Codex 系工具共享。

- 日常使用**不需要**关心它；`doctor` 已配置就直接干活。
- 需要换账号或换库时：`acw ask --profile <名字> ...` 临时切换；长期切换改配置里的 `activeProfile`。
- 查看现有账号与 profile：`acw profiles`。

access_token 临近过期时 CLI 会自动刷新并写回共享库（写前备份），**不会**修改 `~/.codex` 或 CC Switch。刷新失败会明确报错，此时让用户重新导入 auth.json，不要反复重试。

## 归档、备份与检索

新完成问答自动写入当前 profile 配置的 library 的 raw、normalized、index 和 agent 日志；临时条目 ID 为 `native-temp-<会话ID>`。半成品保留在 `native-jobs`，不进入语义索引。

```sh
acw backup             # 固定账号，增量备份普通/归档/项目会话
emb db sync chatgpt          # 把本地新增/变化内容纳入语义索引（库名见 profile 的 embdDb）
emb search '要找的内容' --db chatgpt
```

`backup` 默认保留旧记录和未变化文件，`--full` 才强制重拉；检查返回的 `complete` 与失败清单。保存完整消息树及 Markdown；这条链路不新增下载附件二进制。日常备份与 `emb db sync chatgpt --refresh` 已接到同一固定账号入口，无需浏览器。

## 身份与诊断

`acw account` 核验身份，`acw models` 查看普通聊天模型。找不到命令时，本机完整入口见项目根目录的 `acw`。

认证原件归用户自己的 codex 登录管理；不复制 token、不读取或输出凭据内容、不修改他人登录。出现身份不符就停止，不回退其他账号。

## 平台边界

当前**仅 macOS 已验收**。Windows / Linux 未验证：本工具依赖 ChatGPT.app 内的官方 `devicecheck.node` 与 `cua_node` 做设备证明，其他平台缺少这些组件。不要向用户承诺跨平台可用。

架构与验收说明见项目 README。