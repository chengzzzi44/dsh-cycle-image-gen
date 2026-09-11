# 分发给同事

`recycle-image-gen` 是一个完整的 DSH 插件包（Host 半边 + 浏览器半边），装进对方的 `web` profile 就能用。分两步：你打包，对方安装。

## 一、打包（你这边）

```sh
cd /path/to/recycle-image-gen
npm install        # 装构建依赖，并自动执行 prepare 构建 lib/
npm pack           # 产出 recycle-image-gen-<version>.tgz
```

产物约 32 KB，里面是 7 个文件：

```
package/package.json
package/lib/index.js       # Host 半边：generate_image 工具 + image-gen 设置段
package/lib/client.js      # 浏览器半边：工具卡片 + 收尾缩略图 + 设置卡片
package/cordis.patch.yml   # bundle 层：插入插件行，默认值读环境变量
package/README.md
package/DISTRIBUTE.md
package/LICENSE
```

包里**不含**中转站地址、也不含任何密钥 —— 这些只在你自己的 `cordis.patch.yml`、`~/.dsh/.env`、凭据域里。发之前也确认别把 `~/.dsh/profiles/web/cordis.patch.yml`、`~/.dsh/.env`、`output/`、`selftest-output/` 一起发出去。

改了代码要重新发时，先升版本再打包，这样对方能分清新旧：

```sh
npm version patch --no-git-tag-version && npm pack
```

## 二、对方安装

前提：对方已经能用同一套 `dsh`（本方验证过的版本见 README「已验证版本」），**PATH 里有 `pnpm`**（`dsh plugin` 把参数转发给 pnpm，缺了会以 127 退出），并且用 Web GUI（`web` profile）。如果这个包已经发布到 npm，直接 `dsh plugin --profile web add recycle-image-gen` 即可，不必发 tgz。

```sh
# 1. 把 tgz 放到任意目录，然后装进 web profile
dsh plugin --profile web add ./recycle-image-gen-0.1.0.tgz

# 2. 重启
dsh web
```

如果对方的 `dsh` 不在 PATH 里，就用他平时启动 GUI 的方式，例如在 harness 仓库里 `pnpm dsh plugin --profile web add ...`。

`dsh plugin` 会把包追加到 `$DSH_HOME/profiles/web/package.json` 的 `dsh.profile.bundles`，并用 pnpm 装好它唯一的运行时依赖 `@deepseek-ai/schemastery`（自动装，对方不用管）。

## 三、对方配置

打开 **设置 → 插件 → 插件配置**，展开「recycle-image-gen」卡片，填三项后保存：

| 字段 | 说明 |
|---|---|
| 接口地址 | 中转站前缀，**到版本段为止**，例如 `https://relay.example.com/v1` |
| 模型 | 中转站支持的模型 id |
| 接口密钥 | 写进凭据域，永不回显；留空表示不改 |

保存后立即对下一次生成生效，**不需要重启**。不想用界面也行：把地址和模型写进 profile 的 `cordis.patch.yml`，密钥写进 `~/.dsh/.env`（可写层）或环境变量。

## 四、验证装好了

```sh
dsh --profile web --dump-config | grep -A 8 recycle-image-gen
```

或者直接在对话里说「画一只橘猫」，图片会出现在工具卡片里和回复下方。

## 五、卸载

```sh
dsh plugin --profile web remove recycle-image-gen
```

然后重启。

## 注意

- **各用各的密钥。** 发插件 ≠ 发中转站账号：地址可以共用，key 必须各自提供，否则花的是你的额度。
- **别和 `@dickpy/dsh-imagegen` 同时启用。** 两者都注册 `generate_image` 工具和同名的工具卡片 slot，同时挂载会有一个加载失败；装之前先确认对方没装，或禁用其中一个。
- **设置卡片依赖设置服务。** 随附的 `web` 模板默认挂载；没有挂载设置服务的组合里卡片不出现（也不注册命名空间），插件其余部分照常，配置走 `cordis.patch.yml` / 环境变量。
- **密钥输入框在两种情况下是灰的**（这是对的）：凭据来自启动进程的环境变量时（环境层优先，写了不生效），或部署没有凭据服务。卡片会写出原因。
- **参考图走本机文件路径。** `image` 参数是宿主进程能读到的路径，插件用 `node:fs` 读；远程沙箱（E2B）部署不适用。
- **看图/改图需要 vision 路由。** 纯文本模型下图片仍会显示给用户，但模型只拿到占位文本和文件路径。
