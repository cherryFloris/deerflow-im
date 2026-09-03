# DeerFlow IM 桥接服务（im-bridge）

把 **dsh-im 式的多机器人 IM 渠道管理体验**接入 DeerFlow，**不修改 DeerFlow 任何源码**。
DeerFlow 只充当「大脑」（Gateway REST/SSE），本服务作为独立进程负责：

- 多平台、多机器人接入（当前：**飞书**、**个人微信（iLink，从 dsh-im 复用）**）
- 凭证管理 UI（本地加密存储，状态接口不回显明文）
- 个人微信采用 **扫码登录**，每微信号对应一个机器人，可绑定多个账号实现多机器人
- 每机器人独立的默认模型 / 智能体（preset）
- 会话 ↔ DeerFlow 线程绑定（`/new` 重置）
- 斜杠命令：`/new` `/model` `/preset` `/status` `/compact` `/help`
- 主动推送（规划中）

## 为什么是「独立桥接服务，且直接复用 dsh-im 渠道实现」

DeerFlow 自带的 IM 渠道（含其内置微信方案）体验较差，因此本服务**不复用 DeerFlow 的渠道**，
而是把 `dsh-im` 的渠道实现直接移植过来：个人微信 iLink 传输层
（`connectors/weixin/api.mjs`，含扫码登录、长轮询 `getupdates`、文本/图片/文件发送、AES-128-ECB
媒体、1800 字分段）与飞书通道（Lark 长连接 `connectors/feishu/`、消息解析 `message-utils.mjs`、
CardKit **流式卡片** `cards.mjs`）均逐字移植自 dsh-im 源码；**唯一替换的是「大脑」**——dsh-im
私有的 DeepSeek Harness 协议换成 DeerFlow Gateway 的 REST/SSE。DeerFlow 源码零改动，仅在部署
配置层（docker-compose + 一个 PAT）配合。

## 架构

```
 IM(飞书 / 个人微信 iLink)
   │ 飞书：官方 WebSocket 长连接（无需公网 IP）
   │ 微信：iLink 长轮询 getupdates（扫码登录，多账号=多机器人）
   ▼
 im-bridge (Node, 本目录)
   ├─ connectors/   飞书(CardKit 流式卡片) / 个人微信(iLink) — 均移植自 dsh-im
   ├─ core/         会话编排 + 斜杠命令
   ├─ deerflow/     Gateway 客户端（PAT 鉴权, SSE 流式）
   ├─ store/        凭证库(加密) + 会话映射（持久化）
   └─ admin/        管理 API + UI（含微信扫码绑定）
   │  Authorization: Bearer <PAT>
   ▼
 DeerFlow Gateway  /api/threads  /api/threads/{id}/runs/stream
   ▼
 LangGraph Agent（大脑）
```

## 鉴权要点（已读 DeerFlow 源码确认）

- 使用 **PAT**：`Authorization: Bearer dfp_...`，对线程/run 路由**自动豁免 CSRF**。
- PAT 必须以浏览器会话签发：`POST /api/v1/auth/pats`
  `{"name":"im-bridge","scopes":["threads:read","threads:write","runs:create","runs:read"],"expires_in_days":365}`
  响应里的 `token` 字段即 `DEERFLOW_PAT`。
- 取历史用 `POST /api/threads/{id}/history`（PAT 白名单；`GET .../messages` 不在白名单）。
- DeerFlow **无 preset 概念**，`/preset` 映射到 `context.agent_name`（自定义 agent 的 `SOUL.md`）。
- **附件暂不支持**：PAT 白名单不含 `POST /api/uploads`，需 internal token 才能上传；v1 文本优先。

## 本地运行

```bash
cd im-bridge
npm install
cp .env.example .env        # 填入 DEERFLOW_GATEWAY_URL / DEERFLOW_PAT / IM_BRIDGE_SECRET
npm run dev                 # 或 node src/index.js
# 打开 http://localhost:10010 管理机器人
```

## Docker（已写入 docker/docker-compose.yaml）

在 `.env`（仓库根）中增加：

```
DEERFLOW_PAT=dfp_xxx
IM_BRIDGE_SECRET=<强随机串>
IM_BRIDGE_ADMIN_TOKEN=<可选>
IM_BRIDGE_PUBLISH_PORT=10010   # 宿主机发布端口（容器内固定 8080，供 nginx 反代）
```

然后（仓库根）：

```bash
docker compose -f docker/docker-compose.yaml up -d --build im-bridge
# 管理 UI： http://localhost:10010  （默认仅回环发布，按安全模型；也可用统一入口 https://<host>:2026/im-bridge/）
```

服务与 `gateway` 同 `deer-flow` 网络，调用 `http://gateway:8001`。

## 使用

1. 打开管理 UI（`http://localhost:10010`，或统一入口 `http://localhost:2026/im-bridge/`）。
2. **飞书**：新增机器人 → 选「飞书」→ 填 App ID / App Secret → 创建并启动。
3. **个人微信（iLink）**：新增机器人 → 选「个人微信 (iLink)」→ 点「绑定微信账号（扫码登录）」
   → 用手机微信扫描弹窗二维码 → 确认后即自动创建并启动一个机器人（**一个微信号一个机器人**，
   可重复绑定多个微信账号实现多机器人）。扫码状态会在弹窗实时刷新。
4. 在 IM 平台给机器人发消息即可对话。
5. 斜杠命令：
   - `/new` 开始新对话
   - `/model <名称>` 切换模型（需 DeerFlow `config.yaml` 模型表允许）
   - `/preset <agent>` 切换智能体（自定义 agent 名）
   - `/status` 查看会话/模型/智能体
   - `/compact` 总结并压缩对话
   - `/help` 帮助

## 扩展新平台

在 `src/connectors/` 下新增一个模块，实现 `startBot(bot)` / `stopBot(botId)`，
在收到消息时调用 `handleInbound({platform, botId, chatId, topicId, userId, text, isCommand, botSettings, reply, replyError})`，
并在 `src/connectors/index.js` 的 `connectors` 与 `platformDescriptors` 中登记即可。
扫码登录类平台（如个人微信）额外导出 `beginLogin` / `getLoginStatus` / `cancelLogin`
并在 `admin/server.js` 登记对应路由即可接入管理 UI 的绑定流程。

## 已知限制

- 个人微信图片/文件：iLink 协议已支持收发（`api.mjs` 含 AES-128-ECB 解密与上传），但 v1 的
  桥接大脑侧仅处理**文本消息**；收到的图片/文件会被忽略（如需多模态，需 DeerFlow 支持附件且
  PAT 放开 `POST /api/uploads`）。发送方向已具备 `sendImage`/`sendFile`。
- 主动推送（botId+targetId 主动发消息）为规划项，尚未实现。
