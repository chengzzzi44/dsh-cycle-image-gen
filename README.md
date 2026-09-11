# recycle-image-gen

DeepSeek Harness 的生图插件：模型可调用的 `generate_image` 工具，通过任意 **OpenAI 兼容**的端点（中转站）**文生图**或**图生图**，生成结果既作为耐久附件进入会话，也内联显示在 Web UI 的对话里。

| 半边 | 产物 | 作用 |
|---|---|---|
| Host（Node） | `lib/index.js` | 注册 `generate_image` 工具：请求中转站、解码图片、写入附件库、可选落盘；并注册 `image-gen` 设置段（地址 / 模型 / 密钥引用） |
| Client（浏览器） | `lib/client.js` | 注册三处 UI：`tool.call.toolview` 的工具卡片、`conversation.chat.turnTail` 的收尾缩略图行，以及「设置 → 插件 → 插件配置」里的 `image-gen` 设置卡片 |

## 图显示在哪里

生成图会在 Web UI 里出现**两次**，两处都来自同一份耐久附件引用：

1. **工具卡片里**（`generate_image` 那一步）—— 在 turn 的「过程 / 思考链」折叠区内。**所有**工具结果都在这里，不是图片特有的。
2. **收尾 assistant 消息下方的「Generated image」行** —— 缩略图，在过程折叠区**之外**，点一下用 `openFile` 在右侧栏打开工作区副本（需配置 `outputDir`）。

第二处是纯插件实现的：`ui-chat` 只允许少数几种节点跳出过程区，`turn-tail` 是其中唯一可被插件认领的（`conversation.chat.turnTail` chain slot）。它本身只给 `{turn, seq, openFile}`、不带图片加载器，所以插件转而注入 `uiConversation` service，用 `imageUrl(sessionId, ref)` / `peekImageUrl` 自己拿会话授权的 URL —— 这与聊天视图给消息和工具画廊用的是同一个加载器。

注意这是个 **chain**：同一个收尾 turn 只会渲染第一个接受它的条目。随附的 web 组合里 `ui-deliverables`（产出文件行）的条目先注册，所以**一个 turn 既生图又改文件时由它认领**，此时缩略图行不显示。

## 安装

前置条件：一个可用的 `dsh`，以及 **PATH 里的 `pnpm`**（`dsh plugin` 把参数转发给 profile 目录里的 pnpm，缺 pnpm 会以 127 退出）。

**从 npm 安装**（推荐；包名由 npm 解析，尚未发布时请用下面两种方式）：

```sh
dsh plugin --profile web add recycle-image-gen
```

**从本仓库源码安装**：

```sh
git clone https://github.com/chengzzzi44/recycle-image-gen.git
cd recycle-image-gen && npm install    # 装构建依赖并执行 prepare，产出 lib/
dsh plugin --profile web add "$PWD"
```

**从 tgz 安装**（离线分发）：见 [DISTRIBUTE.md](DISTRIBUTE.md)。

包声明了 `dsh.bundle`，所以 `dsh plugin` 会把它的 patch 层追加到 `$DSH_HOME/profiles/web/package.json` 的 `dsh.profile.bundles`（`DSH_HOME` 默认 `~/.dsh`）。验证层已生效：

```sh
dsh --profile web --dump-config | grep -A 8 "recycle-image-gen"
```

> 在 DeepSeek Harness 源码 checkout 里工作时，把上面的 `dsh` 换成 `pnpm dsh`。

产物落在 `lib/index.js` 与 `lib/client.js`。运行时只依赖一个包：`@deepseek-ai/schemastery`（设置段的 schema，与 harness 自身的设置服务同版本）。Host 半边的其余部分只用 `node:` 内置模块，Client 半边只从浏览器模块表取 `react`。

### 配置

**推荐用设置面板**：Web UI 里打开「设置 → 插件 → 插件配置」，展开 image-gen 卡片，填接口地址、模型、（可选）密钥，点保存。改动立即对下一次生成生效 —— 不用改文件，也不用重启。

机制上，Host 半边用 `ctx.settings.installSection` 注册 `image-gen` 命名空间，composition 里这一行的 `config` 是它的 **base 层**：已经写在 `cordis.patch.yml` 里的配置继续生效，卡片只写用户覆盖的那几个字段，每个字段旁的「恢复默认」就是清掉这一层覆盖。工具每次调用都重新读一遍这个段，所以保存后不需要重启。

仍可继续写在 profile 自己的 `cordis.patch.yml`（`$DSH_HOME/profiles/web/cordis.patch.yml`）里 —— 后面的层按行覆盖，并且**整体替换** `config`，所以要写全你想保留的键：

```yaml
- id: image-gen
  config:
    baseUrl: 'https://your-relay.example.com/v1'
    model: 'gpt-image-2.5'
    apiKeyEnv: GPT_IMAGE_API_KEY
    outputDir: '/absolute/path/to/generated-images'
```

一个字都不改文件的最小配置是环境变量：`DSH_IMAGE_GEN_BASE_URL` 与 `DSH_IMAGE_GEN_MODEL`（bundle 层的默认值就是读这两个）。

**没有挂载设置服务的部署**（例如自定义的 headless composition）：设置卡片不会出现，`image-gen` 命名空间也不注册，工具本身照常工作 —— 按上面两种方式配置即可。

### 提供密钥

**界面上填**：image-gen 卡片的三行字段之一就是密钥。它读写的不是设置文档，而是**凭据域**（`credentials-local` provider 管理的 `$DSH_HOME/.credentials.yaml`），所以只显示「已配置 / 未配置」、永不回显，密钥本身不会进设置文件。它保存到哪个引用名，由设置段里的 `apiKeyEnv` 决定（默认 `GPT_IMAGE_API_KEY`），卡片会把它显示在提示里。

也可以自己放：

插件按顺序解析凭据：先 `ctx.credentials`（覆盖启动环境、调用目录的 `.env`、以及 **`$DSH_HOME/.env`**），再直接读进程环境变量。所以任选一种：

```sh
# 推荐：写进 Harness home 的 .env，重启后一直有效，不依赖 shell 配置
printf 'GPT_IMAGE_API_KEY=%s\n' 'sk-xxxx' >> "${DSH_HOME:-$HOME/.dsh}/.env" && chmod 600 "${DSH_HOME:-$HOME/.dsh}/.env"

# 或者每次启动前导出
export GPT_IMAGE_API_KEY=sk-xxxx
```

**不要把密钥直接填进 `apiKeyEnv`**：那个字段是凭据的**引用名**（变量名），不是密钥本身。填错的话凭据永远解析不到，工具会报 `no credential for "sk-…"`。键名可以自定义，改 `apiKeyEnv` 指向即可。

### 重启

```sh
dsh web
```

第一次装上插件后需要重启一次：Host 半边要在启动时注册 `image-gen` 设置段。之后在设置面板里的改动**不需要**再重启（工具每次调用都重读该段，密钥也是每次解析）。

重启后对话里直接说「画一只戴墨镜的柴犬」，模型会调用 `generate_image`，图片内联出现在对话中。要在界面上改配置就去「设置 → 插件 → 插件配置 → image-gen」。

## 设置卡片

「设置 → 插件 → 插件配置」里的 image-gen 条目和其它插件一样是**可折叠卡片**：默认收起，只有标题行和一句说明；点标题行展开，才出现下面三个字段和保存按钮。标题行右侧在有任何未保存改动时显示「未保存」（收起状态下也看得到），保存成功后自动收起；保存失败则保持展开，并把失败原因留在底部。

展开后是三行：

| 行 | 写到哪里 | 说明 |
|---|---|---|
| 接口地址 | 设置文档 `image-gen` 段的 `baseUrl` | 到版本段为止；schema 里带绝对 URL 规则，写错在这里就被拒 |
| 模型 | 同一段的 `model` | 发给中转站的模型 id |
| 接口密钥 | 凭据域里的 `apiKeyEnv` 引用 | 输入框始终为空，只显示「已配置 / 未配置」；留空保存表示不改密钥 |

保存会把这几个字段作为**一次**原子写入（带 revision 围栏：draft 期间设置文档如果被别处改过，这次保存会被拒绝并要求重读，而不是覆盖别人的改动），然后再写密钥。带用户覆盖的字段旁的「恢复默认」会清掉该字段的覆盖（密钥行没有这个控件），让它重新继承 composition 里的值。

卡片只在当前部署挂载了设置服务时出现 —— 不挂载就什么都不渲染（而不是渲染一张点不动的卡片）；这是有意的可选依赖：没有它，工具卡片、收尾缩略图、以及 `cordis.patch.yml` 配置路径都不受影响。

## 不安装、直接开发调试

`--patch` overlay 可以按绝对路径挂载插件，改完 `npm run build` 重启即可。先把 `examples/web-overlay.cordis.patch.yml` 里的 `name` 和 `outputDir` 两个绝对路径占位符替换成本机实际路径：

```sh
# 在 DeepSeek Harness 源码 checkout 里执行；overlay 用绝对路径，因此与 cwd 无关
pnpm dsh --profile web --patch /path/to/recycle-image-gen/examples/web-overlay.cordis.patch.yml --port 3099
```

## 配置项

全部字段都在 `cordis.yml` 里可改，插件不硬编码任何部署相关取值。同一份字段表也是 `image-gen` 设置段的 schema（连默认值都在这里），所以设置面板读到的是完整生效配置，而卡片只渲染最常用的三项：`baseUrl`、`model`、密钥。`extraHeaders` 在 schema 里标了 `secret`，它的值不会跨过设置接口。

| 字段 | 默认值 | 说明 |
|---|---|---|
| `baseUrl` | —（必须设置） | 中转站前缀，**到版本段为止**，如 `https://relay.example.com/v1`。未设置时工具仍注册，但每次调用都会明确报错 |
| `endpointPath` | `/images/generations` | 文生图请求的路径，追加到 `baseUrl` |
| `editEndpointPath` | `/images/edits` | 图生图请求的路径；带参考图时走这条，发出的是 `multipart/form-data` |
| `maxInputImageBytes` | `52428800`（50 MiB） | 单张参考图的上传上限 |
| `model` | `gpt-image-2.5` | 发给中转站的模型 id |
| `apiKeyEnv` | `GPT_IMAGE_API_KEY` | 凭据引用名 |
| `defaultSize` | `1024x1024` | 调用未给 `size` 时使用 |
| `defaultQuality` | —（不发送该字段） | 调用未给 `quality` 时使用 |
| `requestTimeoutMs` | `300000` | 整次请求预算，含图片下载 |
| `maxImagesPerCall` | `4` | 单次调用 `n` 的上限 |
| `outputDir` | —（不落盘） | 绝对目录；设置后每个生成图额外写一份文件，便于直接打开或分享 |
| `extraBody` | `{}` | 合并进请求体的额外字段，用于中转站私有参数 |
| `extraHeaders` | `{}` | 额外请求头，用于非 Bearer 的鉴权方案 |

## 工具参数

| 参数 | 必填 | 说明 |
|---|---|---|
| `prompt` | ✅ | 画面描述；图生图时是修改要求 |
| `image` | | 参考图的**文件路径**。给了就走编辑端点（图生图）；不给就是文生图 |
| `mask` | | 蒙版图片的路径（OpenAI 要求 PNG），选定要重绘的区域；必须与 `image` 同时给 |
| `size` | | `宽x高`，需中转站支持 |
| `quality` | | 例如 `low` / `medium` / `high` |
| `background` | | `transparent` 或 `opaque` |
| `n` | | 生成张数，1..`maxImagesPerCall`，默认 1 |

## 工作原理

**图片怎么进入会话。** 中转站返回的 `b64_json`（或 `url`，会被下载）解码成字节，媒体类型由**字节签名**判定而非响应的 content-type，然后经 `ctx.attachments.saveImage()` 提交为内容寻址的耐久附件。工具返回的 canonical value 里带 `attachmentId`，`output.render` 把它变成 `image` 内容块。附件先落库、后追加 `tool/result` 事件，所以重放时引用一定有效。

**模型看不看得见图。** 取决于当前模型是否声明 image 输入。支持的模型能直接看到图；纯文本模型会被 `dsh-llm` 的投影替换成稳定占位文本（`[image omitted because this model accepts text only; …]`），此时模型只拿到附件 id —— 只有在配置了 `outputDir` 时，工具 envelope 里才带有可直接使用的文件路径。两种情况下图都会正常显示给用户。

**图生图的参考图怎么传给模型。** 工具参数是 JSON，图片进不去，所以参考图走**路径**。而 vision 路由下，Harness 的请求投影本来就会在每张图旁边写给模型一段 handle 文本：

```text
Image "photo.png" (sha256:…); request preview 1066x600px. Normalized copy (read-only; may be resized or re-encoded): "/Users/…/.dsh/attachments/…/x.png" (1066x600px, image/png). Source dimensions, format, and byte size may differ.
```

也就是说，用户在对话里贴一张图，**模型天然就拿到了那张图的规范化副本路径**，可以直接把它填进 `image` 参数；生成图则因为插件会把副本写进 `outputDir` 并把路径写进 envelope 文本，同样可以被下一轮引用。注意这条链路需要**声明了 image 输入的模型**（vision 路由）——纯文本模型只会看到占用位文本，拿不到路径。插件本身不做路由门禁：`image` 参数是文件路径，任何模型只要能把路径填对就能用。

**UI 卡片为什么不抢 `tool.call.images`。** 那个 slot 是 `single` 类型、已被内置 `read_image` 视图声明，第二个声明者会在加载时直接抛错。而每个原子 Tool 视图的 owner props 都会拿到会话授权的 `loadImage`，所以本插件自己渲染 `<img>`，对内置 UI 完全增量、零改动。

## 验证

```sh
npm run typecheck    # tsc --noEmit
npm test             # = npm run selftest：两个无密钥自测，见下
```

**Host 自测**（`scripts/selftest.mjs`）起一个本地 HTTP 服务充当假中转站，不需要真实密钥或模型，覆盖：

- **文生图**：JSON 请求体、端点拼接、Bearer 头、`prompt`/`n`/`size`/`model` 字段
- **图生图**：带参考图时切到编辑端点、发出 `multipart/form-data`、boundary 由 `fetch` 掌管、参考图字节确实进了 multipart、`source` 进入 canonical value / envelope / 卡片元数据
- **落盘**：工作区副本与返回字节逐字节一致
- **拒绝路径**：`n` 越界、`mask` 不带 `image`、参考图文件不存在、参考图不是图片格式——且都不消耗中转站请求
- **设置段**：注册的命名空间与 schema 字段、`extraHeaders` 的 `secret` 角色、composition 行作为 base 层、`setSource` + `onChange` 之后下一次调用真的换了端点与模型、以及不可用的段保留上一份好配置
- **可选依赖**：没挂设置服务的部署里，注入顺序仍是「先 settings 再 attachments」，工具照常注册

**Client 自测**（`scripts/client-selftest.mjs`）在 Node 里装上 `window.__ModuleLoader__.load` 的交接、直接求值 `lib/client.js`，然后用合成事件驱动 turn-tail fold，覆盖：

- bundle 以正确的 id 注册，`inject` 声明了 `slots` 与 `locale`，各处 slot 注册都发生在对应的注入回调里
- **设置卡片**：以 `image-gen` 为 key 注册进 `settings.plugin.item`，绑定同名命名空间；没有 `settingsScope` 的部署只少这张卡片
- `turn/start` → `tool/call` → `tool/result` 的折叠产出正确的 turn 数据（附件引用 + 工作区路径）
- **归因**：只有 `generate_image` 的结果进入该行，别的工具返回的图片不会
- **拒绝路径**：`replace` 类型的结果不匹配、失败的调用不贡献、收尾 seq 之后的图片被排除、无图片时 selector 返回 `null` 让出 chain
- inject 工厂拿到 session id 并把 `imageUrl` 绑定到该 session

**已装载验证**（需真实运行）：`--dump-config` 显示该行被 profile 层覆盖；浏览器清单含 `recycle-image-gen/client.js`；combo 产物含 `conversation.chat.turnTail` 与 turn 数据键；`settings.describe` 里出现 `image-gen` 命名空间。

## 已知限制

- **参考图只接受文件路径。** 不支持传 attachment id；也不需要——vision 路由会把规范化副本路径直接写给模型。
- **只上传一张参考图。** OpenAI 的编辑端点支持多图合成（`image[]`），本插件只发单张 `image`，多图合成的 multipart 字段名各家不一，没有可靠依据前不猜。
- **参考图用 `node:fs` 直读。** 不走 `ctx.fs`，因此在远程沙箱（E2B）下，路径必须是宿主进程能读到的本地文件；本地 `web` profile 没问题。
- **只认 OpenAI 兼容响应。** 要求响应体是 `{ data: [{ b64_json | url }] }`。响应结构不同的中转站需要改 `src/relay.ts`。
- **返回 URL 时不带凭据下载。** 图片 URL 常常指向另一台主机，为避免泄露中转站密钥，下载请求不带 `Authorization`；需要鉴权的图床会失败。
- **`extraBody` 在 multipart 路径下只发标量。** 结构化值无法表达为 multipart 字段，只有文生图路径能发。
- **卡片是精简版。** 没有灯箱放大、没有下载按钮；点击图片会用 `openFile` 打开工作区副本（仅当配置了 `outputDir`）。
- **收尾缩略图行可能被产出文件行挤掉。** `conversation.chat.turnTail` 是 chain，同 turn 只渲染第一个认领者；随附的 web 组合里 `ui-deliverables` 的条目先注册，所以既生图又改文件的 turn 由它认领。
- **缩略图行只有图片本身和文件名。** turn-tail 的 owner 不提供灯箱或布局上下文，所以这一行是固定 120px 高的缩略图，不是完整画廊。
- **文案走 `ctx.locale` 字典（命名空间 `recycle-image-gen`）。** 因此浏览器半边把 `locale` 声明为必需依赖：组合里没有 locale 服务时整个浏览器半边不激活（Host 半边的工具不受影响）。
- **设置段 schema 与运行时校验是两处。** 设置段用 `@deepseek-ai/schemastery` 声明（含绝对 URL 规则），工具运行时仍走手写的 `resolveConfig`：schema 管住界面写入，`resolveConfig` 管住每一次调用，两者共享 `src/config.ts` 的默认值常量。schema 表达不了的约束（例如 `maxImagesPerCall` 至少为 1）由 `resolveConfig` 拒绝，此时插件保留上一份好配置并告警。
- **设置卡片只覆盖三项。** `outputDir`、`defaultSize`、`endpointPath`、`extraBody` 等仍要写 `cordis.patch.yml`；卡片是有意做窄的，只放最常改的三个值。
- **密钥字段不回显、也不能清空。** 只显示「已配置 / 未配置」；换 key 直接填新的即可，想彻底删掉引用目前要走 `credentials.unset`（界面没做这个按钮）。
- **密钥输入框可能是禁用的，而且这是正确的。** 凭据域只允许写「可写来源」：如果这个变量是从**启动进程的环境**里传进来的（`export` 后启动、`-e`、CI secret），环境层优先于托管文件，写进去也不会生效，所以控件禁用并在下面说明原因；`$DSH_HOME/.env` 与 `$DSH_HOME/.credentials.yaml` 都是可写的。想知道当前 key 从哪来，看卡片提示里显示的引用名，或直接看 `describe` 的 `source`。没有挂载凭据服务的部署同理（提示里会说）。
- **凭据命名空间是按 `remote.credentials` 这个服务名取的。** 客户端 Remote 把每个命名空间注册成独立服务（服务名 `remote.<namespace>`），`remote` 服务本身只有 `$on`/`$mount`/`$host`；插件通过作用域注入按需读取，晚挂载时会重新读取，所以不依赖挂载顺序。
- **收尾缩略图行依赖 `uiConversation` 客户端服务。** 该行经 `ctx.inject(['uiConversation'], …)` 注册；组合里没有这个服务时只少这一行，工具卡片与设置卡片不受影响。
- **未声明 DSH 版本兼容范围。** 浏览器半边依赖若干 pre-stable 内部面（`uiConversation`、`settingsScope`、`settings.plugin.item`、`remote.credentials`、turn data schema），Host 半边依赖 `ctx.tools` / `ctx.attachments` / `ctx.credentials` / `ctx.settings`。升级 harness 后请重跑 `npm test` 并做一次实际装载验证。
- **未接入 OpenAI 的 `output_format` 参数。** 输出格式由中转站决定，插件按字节签名自适应。

## 贡献

- `npm ci` 安装依赖并构建（`prepare` 会产出 `lib/`），`npm test` 跑两个无密钥自测，`npm run typecheck` 做类型检查；CI 在 Node 22 / 24 上跑同样的三步。
- 改动 `src/*.ts` 或 `src/client/*` 后必须 `npm run build`：profile 装载的是 `lib/`，不是源码。
- 行为或模型可见输出有变化时，请同步更新本 README 的对应章节。

## 已验证版本

发布 0.1.0 时验证过的环境：

- Node.js 22：`npm run typecheck`、`npm test` 通过。
- DeepSeek Harness 源码 checkout（`@deepseek-ai/dsh-*` 0.1.5-alpha.1）：`web` profile 装载后 `generate_image` 工具注册可用。

浏览器半边绑定了 harness 的若干 pre-stable 内部服务与插槽（`uiConversation`、`settingsScope`、`settings.plugin.item`、`remote.credentials`）。换 harness 版本后请重跑 `npm test`，并在 Web UI 里确认工具卡片、缩略图行与设置卡片都还在。

## License

[MIT](LICENSE)
