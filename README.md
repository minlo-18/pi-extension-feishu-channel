# pi-extension-feishu-channel

面向 **pi-agent** 的飞书 / Lark 聊天渠道插件。它把一个飞书机器人接到 pi coding-agent 会话上：

- **扫码登录（默认）**：首次运行若没有凭证，自动弹出**二维码**，用飞书手机 App 扫码即可**选择或创建**一个机器人，凭证自动落盘——无需手动复制 App ID / App Secret。也可随时 `/feishu-login`。
- **收消息**：通过飞书 **WebSocket 长连接** 接收 `im.message.receive_v1`。入站先经**逻辑重试去重**（防长连接重推）→ **同发送人去抖合并**（连发消息并成一个 turn）→ **准入网关**（私聊白名单 / 群策略 / @提及 / 机器人过滤）→ **每会话串行队列**（同会话 FIFO、异会话并发、超时驱逐防卡死）。图片内联转多模态、文件/语音/视频下载落地后交给 agent。
- **流式回复**：随 agent 生成 token **实时刷新 CardKit 打字机卡片**（`streaming_mode`），结束时定稿；CardKit 不可用/失败时回退普通消息。
- **处理中表情**：收到消息后立即在你的消息上加一个“处理中”表情（默认 `OnIt`），回答完自动移除、失败换成失败表情——熟悉的"已收到/正在处理"反馈。
- **静态卡片升级**：非流式回复含代码块/表格时，用 **schema-2.0 交互卡片**渲染（优于 post），其余 markdown 走 `post`。
- **交互卡片审批**：可选开启后，危险工具调用先发 **Approve/Deny 卡片**并阻塞，按钮点击带 **token 去重**，人工批准后才执行。
- **出站媒体工具**：注册 `feishu_send_file`，让 agent 主动把本地图片/文件推送到会话。
- **聊天内命令**：`/`开头的消息被拦截、不发给模型——`/help` `/status` `/model` `/thinking` `/stop` 直接控制 pi 会话（切模型/思考强度/停止/查状态）。

实现思路借鉴 **hermes-agent 的 `FeishuAdapter`**（长连接、准入、归一化、媒体、审批、身份 hydrate）与 **openclaw 的 feishu channel**（扫码开通、CardKit 流式、逻辑重试去重键、每会话串行队列+超时驱逐、输入去抖、静态卡片、卡片 token 去重），并按 **pi-agent 的 extension 规范**重写：工厂 `(pi) => void` 入口，`session_start` 连接（缺凭证走扫码）、`message_update` 流式、`tool_call` 审批、`agent_end` 定稿/投递、`session_shutdown` 断开。

> 为什么用官方 Node SDK 而不是调 lark-cli？lark-cli 是 Go 二进制（通过 npm 分发原生可执行文件），**没有可导入的 JS 库**，只能作为子进程 shell out。本插件选择 **`@larksuiteoapi/node-sdk`**（lark-cli 内部所封装的 Go SDK 的 Node 等价物），做到**进程内、自包含、零外部二进制**，符合“部署包自包含”的原则。扫码登录直接用 SDK 自带的 `registerApp()`（scan-to-create/select），不手搓 device-code 端点。

---

## 目录结构

```
pi-extension-feishu-channel/
├── index.ts                      # 入口：生命周期 + 扫码开通 + 去重/去抖/队列编排 + 流式 + 审批 + 投递
├── config.ts                     # 配置加载 + 凭证持久化 saveCredentials（env + 受信任的项目本地 JSON）
├── feishu-client.ts              # node-sdk 封装：长连接/收发/上传下载/CardKit/卡片/身份
├── onboarding.ts                 # 扫码开通：registerApp + 终端二维码渲染 + 结果落盘
├── message.ts                    # 消息适配：飞书 <-> 文本/富文本/媒体/卡片（纯函数，易测）
├── streaming-card.ts             # CardKit 流式会话（create/节流快照 update/finalize）
├── dedup.ts                      # 逻辑重试去重键 + claim/commit 协议
├── debounce.ts                   # 同发送人连发文本去抖合并为一个 turn
├── queue.ts                      # 每会话串行队列（FIFO/并发/超时驱逐不 abort）
├── package.json                  # pi manifest（pi.extensions）+ 依赖声明
├── feishu-channel.example.json   # 配置样例（复制到 .pi/feishu-channel.json）
├── .gitignore
└── README.md
```

---

## 〇、扫码登录（默认 · 最省事）

装好插件后**直接启动 `pi`**：没有凭证时插件会在终端打印一个二维码。用**飞书手机 App 扫一扫**，页面上**选择已有机器人或新建一个**并确认授权，插件即自动拿到 `App ID / App Secret`、写入 `<project>/.pi/feishu-channel.json`，随后立即连上——**全程不用手动复制密钥、不用进开发者后台配权限**（扫码页已预填 IM 所需的权限/事件/回调，你确认即可）。

```bash
pi                    # 无凭证时自动进入扫码；或随时手动触发：
/feishu-login         # 在 pi 里输入，重新扫码登录（/feishu-login lark 走国际版）
```

- 二维码需要一个**交互式终端**来显示。无 TTY（如 systemd 后台）时不会自动弹码——先在可交互的 shell 里跑一次 `pi` + `/feishu-login` 生成 `feishu-channel.json`，再交给后台常驻即可。
- 关掉扫码、只用手动凭证：设 `FEISHU_ONBOARDING=false`。
- 想固定“只新建不选择”或走国际版 Lark，见 [onboarding.ts](./onboarding.ts) 的 `createOnly` / `domain` 选项。

> 如果你更习惯手动在开发者后台建应用、或扫码不可用，下面 **第一节** 给出完整手动步骤；两条路二选一即可。

---

## 一、飞书开放平台配置（手动方式 · 可选）

1. 打开 [开发者后台](https://open.feishu.cn/app) → 创建 **企业自建应用**。
2. 记录 **App ID**（`cli_...`）和 **App Secret**。
3. **添加机器人能力**：应用功能 → 机器人 → 启用。
4. **开通权限**（权限管理 → 至少）：
   - `im:message`（收发消息）
   - `im:message.group_at_msg`（接收群里被 @ 的消息）
   - `im:message.p2p_msg`（接收单聊消息）
   - `im:resource`（**媒体功能必需**：下载消息里的图片/文件/语音/视频）
   - `im:chat:readonly`（可选，读取会话信息）
5. **事件订阅**：事件与回调 → 订阅方式选择 **“使用长连接接收事件”**（无需公网地址）。
   - 添加事件：**接收消息 `im.message.receive_v1`**。
   - 若启用**卡片审批**：在“回调/Callback”里订阅 **卡片交互 `card.action.trigger`**（同样走长连接，无需公网）。
   > 长连接注意事项：仅支持企业自建应用；收到事件需 3 秒内处理完毕；每个应用最多 50 条连接；同一应用多实例为集群模式（随机一个实例收到消息）。
6. **发布版本**：版本管理与发布 → 创建版本并发布（企业内自动生效）。
7. 把机器人拉进目标群，或直接与机器人私聊。

---

## 二、安装插件

插件带一个 npm 依赖（`@larksuiteoapi/node-sdk`）。pi 用 `jiti` 从扩展自身的 `node_modules` 解析依赖，**无需编译**。

### 方式 A：`pi install git:`（推荐，ECS 一条命令搞定）

pi 会 `git clone` 到 `~/.pi/agent/git/`，检测到 `package.json` 里有 `dependencies` 后**自动 `npm install`**，并写入 settings 自动加载——无需手动装依赖。

```bash
pi install git:github.com/minlo-18/pi-extension-feishu-channel
```

私有仓库或需固定分支/标签时：

```bash
pi install git:github.com/minlo-18/pi-extension-feishu-channel@main
# 私有仓库：先让 git 能免密访问（gh auth login，或配置 SSH deploy key 后用 ssh 形式）
pi install ssh://git@github.com/minlo-18/pi-extension-feishu-channel
```

升级到最新提交：

```bash
pi update --extensions          # 更新所有已安装扩展
# 或指向本插件重新安装
pi install git:github.com/minlo-18/pi-extension-feishu-channel
```

卸载：

```bash
pi remove git:github.com/minlo-18/pi-extension-feishu-channel
```

> ECS 前置条件：已安装 `pi`（`@earendil-works/pi-coding-agent`）、`git`、`node >= 20`，且机器能出网访问 GitHub 与飞书开放平台。装完后按 [第三节](#三配置凭证) 注入 `FEISHU_APP_ID/APP_SECRET` 即可 `pi` 启动。

### 方式 B：手动 clone（离线/内网镜像场景）

```bash
git clone https://github.com/minlo-18/pi-extension-feishu-channel ~/.pi/agent/extensions/pi-extension-feishu-channel
cd ~/.pi/agent/extensions/pi-extension-feishu-channel
npm install --omit=dev        # 只装运行期依赖
```

放到 `~/.pi/agent/extensions/`（全局）或 `<project>/.pi/extensions/`（项目本地，需 trust）即被自动发现。

### 方式 C：显式加载（本地试用，不安装到扩展目录）

```bash
pi --extension /abs/path/to/pi-extension-feishu-channel/index.ts
```

---

## 三、配置凭证

支持两种方式，**环境变量优先于 JSON 文件**。

### 方式 1：环境变量（推荐用于服务器 / Ubuntu 部署）

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `FEISHU_APP_ID` | ✅ | — | 应用 App ID（`cli_...`） |
| `FEISHU_APP_SECRET` | ✅ | — | 应用 App Secret |
| `FEISHU_DOMAIN` | | `feishu` | `feishu`（国内）或 `lark`（国际） |
| `FEISHU_REQUIRE_MENTION` | | `true` | 群聊里仅在被 @ 时响应 |
| `FEISHU_ALLOW_BOTS` | | `none` | `none` / `mentions` / `all`：是否处理其他机器人消息 |
| `FEISHU_GROUP_POLICY` | | `open` | `open` / `allowlist` / `disabled` |
| `FEISHU_ALLOWED_CHATS` | | 空 | `allowlist` 时允许的 `chat_id`（逗号分隔） |
| `FEISHU_ALLOWED_USERS` | | 空 | 私聊白名单 `open_id`（空=允许所有人私聊除非另设） |
| `FEISHU_ALLOW_ALL_USERS` | | `false` | 允许任何人私聊（覆盖白名单） |
| `FEISHU_BOT_OPEN_ID` | | 自动获取 | 机器人自身 open_id（用于 @ 检测；留空自动 hydrate） |
| `FEISHU_BOT_NAME` | | 自动获取 | 机器人名字（用于清理 @token） |
| `FEISHU_REPLY_IN_GROUP` | | `true` | 群聊回复是否串接到触发消息 |
| `FEISHU_MAX_MESSAGE_LENGTH` | | `8000` | 单条飞书消息最大字符数，超出自动分片 |
| `FEISHU_RICH_TEXT` | | `true` | 回复含 markdown 时渲染为飞书 `post` 富文本（标题/加粗/列表/链接/代码），被拒时回退纯文本 |
| `FEISHU_FORWARD_MEDIA` | | `true` | 下载入站图片/文件/语音/视频转给 agent（图片内联，文件落地并把路径附到 prompt） |
| `FEISHU_INBOUND_DIR` | | 系统临时目录 | 入站文件保存目录（默认 `<tmp>/pi-feishu-inbound`） |
| `FEISHU_APPROVAL_ENABLED` | | `false` | 开启工具调用的卡片审批（Approve/Deny 后才执行） |
| `FEISHU_APPROVAL_TOOLS` | | 空 | 需审批的工具名（逗号分隔）；空或 `*` = 所有工具 |
| `FEISHU_APPROVAL_TIMEOUT_MS` | | `300000` | 等待审批点击的超时（毫秒） |
| `FEISHU_APPROVAL_TIMEOUT_ALLOW` | | `false` | 超时决策：`true`=放行，`false`=拒绝 |
| `FEISHU_STREAMING` | | `true` | 流式回复：随生成实时刷新 CardKit 打字机卡片 |
| `FEISHU_STREAMING_THROTTLE_MS` | | `160` | 流式卡片最小刷新间隔（毫秒） |
| `FEISHU_STATIC_CARD` | | `true` | 非流式回复含代码块/表格时用 schema-2.0 卡片渲染 |
| `FEISHU_DEBOUNCE_ENABLED` | | `true` | 合并同发送人连发的文本为一个 turn |
| `FEISHU_DEBOUNCE_MS` | | `800` | 去抖静默窗口（毫秒），0 关闭合并 |
| `FEISHU_QUEUE_ENABLED` | | `true` | 每会话串行处理（同会话 FIFO、异会话并发） |
| `FEISHU_QUEUE_TASK_TIMEOUT_MS` | | `300000` | 单任务超时后从阻塞链驱逐（不 abort），防卡死 |
| `FEISHU_DEDUP_ENABLED` | | `true` | 逻辑重试去重（防长连接重推同一逻辑消息） |
| `FEISHU_DEDUP_TTL_MS` | | `86400000` | 去重缓存保留时长（毫秒，默认 24h） |
| `FEISHU_ONBOARDING` | | `true` | 缺凭证时默认走二维码扫码登录（需交互式终端）；设 `false` 只用手动凭证 |
| `FEISHU_REACT_ENABLED` | | `true` | 收到消息时在触发消息上加“处理中”表情，回答完移除（失败换失败表情） |
| `FEISHU_REACT_EMOJI` | | `OnIt` | 处理中表情的 emoji_type（如 `OnIt`/`Typing`/`Thinking`/`Get`） |
| `FEISHU_REACT_FAIL_EMOJI` | | `CrossMark` | 失败时替换的 emoji_type；留空则仅移除处理中表情 |

```bash
export FEISHU_APP_ID="cli_xxxxxxxx"
export FEISHU_APP_SECRET="xxxxxxxx"
```

### 方式 2：项目本地 JSON 文件

复制样例并填入凭证（仅在项目被 **信任 trust** 时读取；也可用 `--feishu-config <path>` 显式指定）：

```bash
cp feishu-channel.example.json <your-project>/.pi/feishu-channel.json
```

> ⚠️ 切勿把含真实 secret 的 `feishu-channel.json` 提交到 git（`.gitignore` 已默认忽略）。

---

## 四、运行

配置好后，正常启动 pi 即可，插件在 `session_start` 时自动连接：

```bash
cd <your-project>
pi
```

- TUI 里会看到 “Feishu channel connected” 通知，状态栏显示 `🪽 Feishu`。
- 在飞书里私聊机器人，或在群里 @机器人 发消息 → 内容进入 agent → agent 回复回投到该会话。
- 随时用 `/feishu-status` 查看连接状态、当前绑定会话与最近日志。

### 在飞书里可用的命令

`/`开头的消息会被插件**拦截**、不发给模型，用来直接控制 pi 会话：

| 命令 | 作用 |
|---|---|
| `/help` | 显示命令帮助 |
| `/status` | 查看当前模型、思考强度、上下文占用、运行状态 |
| `/model` | 列出可用模型；`/model <名称或id>` 切换模型 |
| `/thinking` | 查看思考强度；`/thinking <off\|minimal\|low\|medium\|high\|xhigh\|max>` 设置 |
| `/stop` | 停止当前这条回复（`ctx.abort()`） |
| `/clear`、`/new` | 提示：本桥接是单会话，无法从聊天里新建/切换会话；请在 pi 终端里 `/new` 或重启，聊天会跟随 |

> 说明：pi 只把「新建/fork/切换会话」暴露给它自己的斜杠命令处理器，**不开放给渠道入站回调**——所以 `/new` 只能在 pi 终端里做。其余（切模型、思考强度、停止、状态）从飞书即可操作。

### 无界面 / 后台运行

飞书渠道是外部触发源，天然适合无头运行。可用 print/rpc 模式或让会话保持常驻：

```bash
# 让 pi 保持一个常驻会话，仅由飞书消息驱动
pi
```

> 说明：pi 是**单会话** agent。本插件对多会话做了串行化——首个活跃会话被绑定；当 agent 正忙时，来自**同一会话**的新消息作为 `followUp` 排队，来自**其他会话**的消息会收到“正忙，请稍后”的提示，避免被静默丢弃。

---

## 五、Ubuntu 目标平台部署

```bash
# 1) Node 20+（jiti / SDK 要求）
node -v

# 2) 放置扩展并安装依赖（自包含）
mkdir -p ~/.pi/agent/extensions
cp -r pi-extension-feishu-channel ~/.pi/agent/extensions/
cd ~/.pi/agent/extensions/pi-extension-feishu-channel
npm install --omit=dev   # 只装运行期依赖 @larksuiteoapi/node-sdk

# 3) 注入凭证（建议放入 systemd/service 的 Environment 或 .env）
export FEISHU_APP_ID="cli_xxxx"
export FEISHU_APP_SECRET="xxxx"

# 4) 启动 pi（长连接无需公网入站端口，仅需出网访问飞书）
cd /path/to/your/project
pi
```

用 systemd 常驻的示例（片段）：

```ini
[Service]
Environment=FEISHU_APP_ID=cli_xxxx
Environment=FEISHU_APP_SECRET=xxxx
Environment=FEISHU_REQUIRE_MENTION=true
WorkingDirectory=/path/to/your/project
ExecStart=/usr/bin/pi
Restart=always
```

---

## 六、消息流（时序）

```
飞书用户 ──消息/媒体──▶ 开放平台 ──WS长连接──▶ WSClient
                                          │ im.message.receive_v1
                                          ▼
                                 normalizeInbound()  归一化+@解析+媒体引用
                                          ▼
                          dedup.claim()  逻辑重试去重（丢弃 duplicate/inflight）
                                          ▼
                                     admit()  准入网关
                                          ▼
                    debounce.push()  同发送人连发合并（静默 debounceMs 后 flush）
                                          ▼
                    queue.enqueue(chat)  每会话串行（超时驱逐不 abort）
                                          ▼
                         collectMedia()  下载图片(内联)/文件(落地)
                                          ▼
                    pi.sendUserMessage(text + images)  注入 agent
                                          ▼
                                   （agent 推理…）
       message_update ──▶ FeishuStreamingSession.update(snapshot)  节流刷新 CardKit
                     ┌────────────────────┴───────────────────┐
                     │ 每次工具调用（可选）                     │
                     ▼                                          │
   pi.on("tool_call") ── sendCard(审批卡) ──▶ 飞书              │
        ▲ Approve/Deny 点击 ◀── card.action.trigger ◀──────────┘
        │  token 去重 → approve 放行 / deny → { block: true }
                                          ▼
        pi.on("agent_end") ── 有流式? finalize 定稿（跳过重复发送）
                                          ▼
              无流式：代码块/表格? → schema-2.0 静态卡片
                     : markdown? → post 富文本 : text ──▶ 飞书会话

agent 主动推文件：feishu_send_file 工具 → uploadImage/uploadFile → 发送到会话
```

关键映射（对照 hermes / openclaw）：

| 关注点 | hermes / openclaw | 本插件（pi extension） |
|---|---|---|
| 传输 | WSClient 长连接 | `@larksuiteoapi/node-sdk` `WSClient` 长连接 |
| 收消息 | `register(im.message.receive_v1)` | `EventDispatcher.register({ "im.message.receive_v1" })` |
| 归一化 | `normalize_feishu_message` | `message.ts: normalizeInbound` |
| 去重 | openclaw `resolveFeishuMessageDedupeKey`（text-retry 身份） | `dedup.ts: resolveDedupeKey` + claim/commit |
| 去抖合并 | openclaw inbound debouncer | `debounce.ts: createInboundDebouncer` |
| 串行队列 | openclaw `createSequentialQueue`（超时驱逐） | `queue.ts: createSequentialQueue` |
| 准入 | `_admit` / `_mentions_self` | `index.ts: admit` / `message.ts: mentionsSelf` |
| 身份 | `_hydrate_bot_identity` | `feishu-client.ts: hydrateBotIdentity` |
| 入站媒体 | `message_resource.get` | `feishu-client.ts: downloadResource` → 图片内联/文件落地 |
| 出站媒体 | `send_image_file` / 上传 | `feishu-client.ts: uploadImage/uploadFile` + `feishu_send_file` 工具 |
| 流式回复 | openclaw `FeishuStreamingSession`（CardKit） | `streaming-card.ts: FeishuStreamingSession`（`message_update` 驱动） |
| 静态卡片 | openclaw `shouldUseCard`（代码/表格） | `message.ts: hasCodeOrTable` + `buildStaticContentCard` |
| 富文本 | `_build_markdown_post_payload` | `message.ts: buildOutboundPayload` / `renderMarkdownToPostRows` |
| 卡片审批 | `send_exec_approval` + token 去重 | `index.ts: tool_call`（阻塞）+ `buildApprovalCard` + `card.action.trigger` + token 去重 |
| 发送 | `message.reply` / `.create` | `feishu-client.ts: replyToMessage` / `sendToChat` / `sendCardEntity` |
| 注入 agent | 内部 gateway 会话 | `pi.sendUserMessage`（文本+图片，`deliverAs: followUp`） |
| 生命周期 | `connect` / `disconnect` | `session_start` / `session_shutdown` |

---

## 七、双向媒体、富文本与卡片审批

### 入站媒体（用户 → agent）
开启 `forwardMedia`（默认开）后：
- **图片** 下载后以 base64 内联为 pi 的 `ImageContent`，多模态模型可直接“看到”。
- **文件 / 语音 / 视频** 下载到 `inboundDir`，把本地路径作为文本附加到 prompt，agent 可用自身 `read` 等工具打开。
- 需要 `im:resource` 权限；下载走 `im.messageResource.get`（同会话、100MB 内）。

### 出站媒体（agent → 用户）
插件注册了工具 **`feishu_send_file`**：agent 传一个绝对路径即可把图片/文件推到当前绑定会话（截图、生成的产物、日志等）。图片走 `im.image.create`，其它走 `im.file.create`。

### markdown → 富文本
`richText`（默认开）时，若回复包含 markdown（标题/加粗/斜体/列表/引用/链接/代码围栏），渲染为飞书 `post` 富文本；否则或被服务端拒绝时，自动回退为纯 `text`，保证永不发送失败。

### 交互卡片审批（危险操作前人工确认）
`approvalEnabled` 打开后，命中 `approvalTools`（或 `*`）的每次工具调用会先向绑定会话发送一张 **Approve / Deny 卡片**，并**阻塞**该次调用：
- 点击 **Approve** → 工具正常执行；点击 **Deny** → 返回 `{ block: true }`，pi 跳过该工具。
- 按钮点击带 **token 去重**（`accountId:token`，15 分钟 TTL，inflight/completed），防飞书重复投递导致重复处理。
- 超时按 `approvalTimeoutAllow` 决策（默认拒绝），卡片点击后就地更新为“已批准/已拒绝”。
- 依赖长连接订阅 `card.action.trigger`（见第一节步骤 5）。

这利用了 pi 的 `tool_call` 钩子是**异步阻塞**且可返回 `{ block, reason }` 的特性，等价于 hermes 的 `send_exec_approval` 流程。

---

## 八、借鉴 openclaw 的六项增强

| 特性 | 作用 | 配置开关 | 模块 |
|---|---|---|---|
| **CardKit 流式回复** | 随 token 生成实时刷新“打字机”卡片，`agent_end` 定稿关流 | `streaming` / `streamingThrottleMs` | [streaming-card.ts](./streaming-card.ts) |
| **逻辑重试去重** | 用 `sender+chat+create_time+sha256(content)` 作 key，挡住飞书用新 message_id 重推同一逻辑消息（长连接重连/超时重推） | `dedupEnabled` / `dedupTtlMs` | [dedup.ts](./dedup.ts) |
| **每会话串行队列** | 同 chat FIFO、异 chat 并发；单任务超时**驱逐出阻塞链但不 abort**，防挂起 turn 永久堵死会话 | `queueEnabled` / `queueTaskTimeoutMs` | [queue.ts](./queue.ts) |
| **输入去抖合并** | 同发送人连发的文本在静默窗口后合并成一个 turn，省 token、更自然 | `debounceEnabled` / `debounceMs` | [debounce.ts](./debounce.ts) |
| **静态卡片升级** | 含代码块/表格的回复用 schema-2.0 卡片渲染（优于 post） | `staticCard` | [message.ts](./message.ts) |
| **审批卡 token 去重** | 按钮点击按 token 声明，防重复处理同一次点击 | 随 `approvalEnabled` 生效 | [index.ts](./index.ts) |

流式说明：本插件用 CardKit（`cardkit.v1.card.create` 建卡 → `cardElement.content` 推**全量快照**、CardKit 自算增量 → `card.settings` 关流），节流为 `160ms` + 句末标点/大增量立即刷新 + 单调 `sequence` 有序。相比 openclaw 我们做了**简化**：单卡片、单 turn，不搬其“generation/settlement 竞态状态机”（那是为多 payload/broadcast 服务的，pi 单会话用不到）。任何一步失败都回退普通消息，并对流式启动失败做 60s 退避。

---

## 九、后续可扩展

- 🔜 流式思考块（reasoning 预览）、状态行（工具进度 `🔧`）；markdown 表格 / 图片元素直接进 post；语音消息本地 STT；富审批卡（Allow Once/Session/Always）；per-chat 会话隔离（需 pi 多会话能力）；去重/去抖状态持久化（跨重启，需持久层）。

这些都可以在对应模块里增量扩展，不影响现有 extension 契约。
