# GPTWeb 首次配置

只有当 `gptnative doctor` 返回 `"configured": false`，或用户要换账号/换存储位置/加新账号库时，才需要读这份文档。

## 一、准备 auth.json

**推荐用一条命令完成登录，跳过手动找文件**：

```sh
gptnative login
```

它会打印登录链接与一次性验证码，浏览器输入后凭据自动导入，无需手工复制 auth.json。

---

### 备选：手动提供 auth.json

需要一个 **Codex 标准格式的 auth.json**。通常来自：


```
~/.codex/auth.json
```

如果这个文件不存在，说明这台机器还没登录过 Codex CLI。让用户在终端运行：

```sh
codex login
```

完成后 `~/.codex/auth.json` 会自动出现。

拿到路径后**不要打开或复制其内容**，直接交给 setup 命令即可。

## 二、首次配置

```sh
gptnative setup --auth ~/.codex/auth.json --library ~/Documents/ChatGPT/websync
```

参数说明：

| 参数 | 含义 |
|---|---|
| `--auth` | auth.json 路径（必填） |
| `--library` | 存储库位置，默认 `~/Documents/ChatGPT/websync` |
| `--profile` | profile 名字，默认 `default` |
| `--force` | 覆盖已存在的同名 profile |

setup 会校验邮箱、邮箱已验证、账号 ID、有效期；不通过会明确报错，**不会**写入无效凭据。

完成后确认：

```sh
gptnative doctor
```

看到 `"configured": true` 即完成。

## 三、改存储位置

改当前 profile 的库：

```sh
gptnative setup --auth ~/.codex/auth.json --library /新的/库路径 --force
```

注意：`--force` 只替换该 profile 的配置，不删除旧库里的文件。

## 四、加第二个账号 / 第二个库

每个账号+库的组合是一个 profile：

```sh
gptnative setup --auth ~/work-auth.json --library ~/Documents/ChatGPT/work --profile work
```

查看全部 profile：

```sh
gptnative profiles
```

临时用某个 profile（不改默认）：

```sh
gptnative ask --profile work --temporary --async --prompt-file /path/q.txt
```

长期切换默认，编辑 `~/.gptaccounts/config.json` 的 `activeProfile` 字段即可。

## 五、换账号的 auth.json

如果用户换了 ChatGPT 账号登录，重新跑一次 setup，指向新的 auth.json：

```sh
gptnative setup --auth /path/to/new-auth.json --library ~/Documents/ChatGPT/websync --force
```

不同邮箱的凭据会并存于 `~/.gptaccounts/credentials/`，不会互相覆盖。

## 六、配置存放位置

```
~/.gptaccounts/
├── config.json                  # 全局配置，0600
├── credentials/
│   ├── <email>.json             # Codex 标准格式，0600
│   └── .bak/                    # token 刷新前的自动备份
```

凭据是 **Codex 标准格式**，与 `~/.codex/auth.json` 一致，其他 Codex 系工具可直接读取同一份。

可用环境变量 `GPTACCOUNTS_HOME` 临时指向别的目录（测试或隔离用）。

## 七、常见问题

| 现象 | 原因与处理 |
|---|---|
| `NOT_CONFIGURED` | 还没 setup，执行第二步 |
| `CREDENTIAL_NOT_FOUND` | 配置指向的账号没有凭据，重新 setup |
| `AUTH_FILE_NOT_FOUND` | `--auth` 路径不对，或还没 `codex login` |
| `UNSUPPORTED_AUTH_MODE` | auth.json 是 API key 模式，本工具只支持 `chatgpt` 模式 |
| `SELECTED_CREDENTIAL_EXPIRED` | access_token 过期且刷新失败，重新导入 auth.json |
| `OFFICIAL_DEVICE_PROOF_UNAVAILABLE` | 不是 macOS 或 ChatGPT.app 不在标准路径，见 README 平台前提 |
| `PROFILE_REQUIRED` | 库里有多账号但没指定 profile |

## 八、安全边界

- 不要打开、打印或复制 auth.json / credentials 里的 token
- 不要修改 `~/.codex` 或 CC Switch 的文件；本工具只读写 `~/.gptaccounts`
- 凭据与配置默认 0600，目录 0700