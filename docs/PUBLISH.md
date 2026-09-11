# 发布指南（维护者）

把新版本发到 npm、排查发布失败、以及哪些东西永远不能提交。面向本仓库维护者，不面向使用者。

## 一、发布前检查

- 工作区干净且已推送：pnpm 默认做 git 检查，脏工作区或落后的分支会被拒绝发布。
- `npm test` 通过（CI 也会在 Node 22 / 24 上跑 typecheck + test + pack）。
- README 的效果图用**绝对 raw URL**：npm 页面按 tarball 里的 README 渲染，相对路径会裂图。
- 版本号：`node -e "console.log(require('./package.json').version)"`。

## 二、npm 凭据：一次配好

账号开了 2FA（auth-and-writes）时，命令行发布必须二选一：token 带 **Bypass 2FA**，或发布时提供 6 位动态码（`--otp`）。本仓库统一用第一种。

### 创建 token

https://www.npmjs.com/settings/&lt;你的用户名&gt;/tokens → Generate New Token

| 类型 | 怎么选 | 为什么 |
|---|---|---|
| **Classic Token → Automation** | 首选 | 不受包范围限制，发布时不需要动态码 |
| **Granular Access Token** | 备选 | ✅ Bypass two-factor authentication (2FA)；Permissions = **Read and write (publish and stage)**；Packages = **All packages**；Expiration 设短（1–7 天） |

首次发布**不要**用 "Only select packages and scopes"：包还不存在，选择器里选不到它；只选自己的用户名 scope 会让发布返回 404。

生成过程中若要求验证码，可在弹窗里点 **Use recovery code**。

### 写进 pnpm 配置

pnpm 不认 `env NPM_CONFIG_//registry.npmjs.org/:_authToken=…` 这种传法，只读自己配置里的 `_auth`：

```sh
pnpm config set //registry.npmjs.org/:_authToken npm_你的token
pnpm whoami        # 应打印用户名
```

macOS 上落在 `~/Library/Preferences/pnpm/config.yaml`。token **不要**提交、不要贴进任何对话或 issue。

## 三、发布

```sh
cd /path/to/recycle-image-gen
pnpm publish
```

- `prepare` 自动跑 `node build.mjs` 构建 `lib/`，不用手动 build；
- 成功输出 `+ recycle-image-gen@<版本>`。

验证：

```sh
pnpm view recycle-image-gen version
```

再打开 https://www.npmjs.com/package/recycle-image-gen 确认描述、关键词、仓库链接、两张效果图。

## 四、发下一个版本

```sh
pnpm version patch            # 0.1.0 → 0.1.1，同时打 git tag
git push && git push --tags
pnpm publish
```

同版本不能覆盖。npm 页面上的 README 固化在已发布版本里，所以 README 的改动也要靠新版本才会反映过去。

## 五、常见错误对照

| 报错 | 含义 | 处理 |
|---|---|---|
| `403 ... Two-factor authentication or granular access token with bypass 2fa enabled is required` | 当前生效的 token 没有 Bypass 2FA | 重建 token 并 `pnpm config set` |
| `404 Not found` | token 的包范围不覆盖这个包（首次发布最常见） | 改用 **All packages** 或 Automation token |
| `401 Unauthorized` / `pnpm whoami` 为空 | token 被删或过期 | 重新生成并重设 |
| npm 页面效果图裂 | README 用了相对路径 | 换回 raw URL 后发新版本 |

排查第一步永远是确认"真正生效的 token"是哪一个：

```sh
pnpm config get //registry.npmjs.org/:_authToken | wc -c   # 10 = 没配（输出是 "undefined"）
pnpm whoami
```

## 六、安全清单

- 发布 token 只存在本机 pnpm 配置里；泄露后立刻到 token 页面删除并重建。
- 发布用 token 建议设短过期，用完即删；长期存放的凭据越少越好。
- recovery codes 与 token 同等敏感，泄露后到 Profile → Two-Factor Authentication 重新生成。
- 仓库里永远不该出现：`.env`、`output/`、`generated-images/`、`*.tgz`、任何真实 key。`.gitignore` 已覆盖这些路径，提交前可用 `git status --ignored` 复查。

## 七、不发 npm 的替代分发

- **tgz**：`pnpm pack` 生成 `recycle-image-gen-<版本>.tgz`，对方 `dsh plugin --profile web add ./recycle-image-gen-<版本>.tgz`。
- **GitHub 源码**：对方 `dsh plugin --profile web add github:chengzzzi44/recycle-image-gen`。git 安装拉源码并跑 `prepare` 构建，pnpm ≥10 会拦截构建脚本，需要在 profile 的 `pnpm-workspace.yaml` 里按提示加 `allowBuilds` 后重试。
