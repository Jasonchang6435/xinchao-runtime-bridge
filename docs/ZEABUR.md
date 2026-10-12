# 在现有心潮项目中增加 Runtime Bridge

云端桥作为现有 Zeabur 项目中的独立第三个服务，使用根目录 Dockerfile。
现有心潮和 OB 镜像不需要修改；OB 无需迁库或重新部署。

## 当前只用 Claude 网页版时

Claude 网页没有本仓库支持的消息注入 Adapter。当前可部署 `DRY_RUN=true`
的观察桥，并开启心潮队列供 `xinchao_context` 拉取。观察桥只订阅投递 ID，
不读取正文、不调用 Webhook、不发送 delivered 或 retryable_failed 回执。
`ready:true` 仅表示当前模式已连上 SSE，`deliveryEnabled:false` 明确表示未开启投递。
这不会让 Claude 网页在后台主动开口，也不是逐轮对话采集器。

## 1. 先备份现有心潮

确认 Zeabur 硬盘中真实挂载 `state → /app/state`。在线备份应校验所有实际存在
的状态文件、SHA256 和 JSON/JSONL，包括 OAuth、主状态、轨迹、小屋、黑匣子、
人格和桥队列。在线稳定文件导出不是停机卷快照。恢复时保留 UID/GID 1000:1000。

保留当前全部环境变量的受保护副本。环境变量更新会重启心潮；不要把桥服务的
env 文件覆盖到心潮上。不要把凭据写到公开仓库、日志或聊天中。

## 2. 心潮服务打开队列

在现有心潮服务补充四项（随机令牌至少 32 字符，推荐 64 位十六进制）：

```dotenv
BRIDGE_ENABLED=true
BRIDGE_MACHINE_TOKEN=<独立机器令牌>
BRIDGE_SELF_SIGNALS=true
BRIDGE_STATE_PATH=/app/state/bridge-queue.json
```

保持现有 MCP、OAuth、Dashboard、OB 地址和读写配置。只重启心潮，核对健康、
OAuth 状态仍在和新队列文件可读写。桥鉴权健康接口应返回：

```json
{"protocol":"xinchao-bridge-server/1","status":"ok"}
```

## 3. 创建独立桥服务

在同一个 Zeabur 项目添加 Git 服务，仓库选择此 fork，分支选择
`codex/zeabur-runtime-bridge`。构建路径保持仓库根目录，Dockerfile 路径填
`Dockerfile`，确认识别为 Docker；监听端口 8080。不要选成静态网站。

按 `deploy/zeabur/bridge.env.example` 配置：

```dotenv
PORT=8080
DRY_RUN=true
XINCHAO_BRIDGE_BASE_URL=https://vvxinchao.zeabur.app
XINCHAO_BRIDGE_MACHINE_TOKEN=<与心潮机器令牌相同>
XINCHAO_BRIDGE_ACCEPT_SELF_SIGNALS=true
XINCHAO_BRIDGE_INJECTOR_MODE=webhook
```

地址填心潮 HTTPS 根地址，不带 `/mcp` 或 `/bridge/v1`。客户端拒绝非本机 HTTP，
因此不要直接填 Zeabur 内网明文地址。桥专用凭据与 OAuth、Dashboard、OB 凭据不同。
可绑定桥诊断域名，供检查 `/healthz` 和 `/readyz`；诊断不包含凭据、正文或目标 URL。

桥主进程不保存消息正文或本地幂等状态，不需要单独持久卷；待投递内容保存在
心潮持久卷。正式 Webhook 接收后端须自己提供持久化幂等和收件箱。
保持桥单副本，避免多个消费者重复投递。

## 4. 健康和重连

| 路由 / 字段 | 含义 |
| --- | --- |
| `/healthz` HTTP 200 | worker 进程正常，适合作为容器存活检查 |
| `/readyz` HTTP 200 | SSE 已连通；断线时返回 503 |
| `mode:dry-run` | 观察模式 |
| `phase:observing-without-ack` | 只看投递 ID，未消费 |
| `receiverConfigured:false` | 尚未配置实际 AI 接收端 |
| `deliveryEnabled:false` | 不进行实际投递 |
| `noticesObserved` | 本进程见过的通知数，不能解释为已送达数 |

SSE 断流或心跳超时后，以指数退避和少量抖动重连。默认从 1 秒增长到最多
30 秒；90 秒没有流活动时重新连接。SIGTERM 会关闭 SSE 和健康服务器。
CLI 原来的 `run` 仍是单次连接，不改变本地用户的使用方式。

Docker 声明 USER node；Zeabur 可能覆盖镜像用户，因此云端入口在发现 root 时
先清理附加组，再降为 UID/GID 1000:1000。降权失败会拒绝启动。远程 exec
进程仍可能是 root，验收应读取主进程身份，不能只看 exec 的 process.getuid()。

## 5. Claude 网页使用

继续使用心潮 `https://vvxinchao.zeabur.app/mcp`，不把桥域名作为 MCP 地址。
新会话先调用 `xinchao_context`（mode=session_start），需要时调用
`xinchao_cabin_inbox` 读取网页来信。未被其他消费者取走的自身信号由上下文带出。
真实对话回传依靠 `xinchao_event` 的 exchange；此功能与桥观察进程独立。

不要将 tmux Adapter 或示例收件箱伪装成 Claude 网页接收器。仅把信封写进文件、
收到 HTTP 200 或成功粘贴，不能证明正确 AI 会话接受了消息。

## 6. 将来开启实际投递

先实现自己控制的 AI Runtime HTTPS Webhook：校验独立 Bearer、绑定唯一账号和
目标 session、按 deliveryId 持久化幂等，确认该会话接受消息后返回：

```json
{"accepted":true,"deliveryId":"同一个投递ID"}
```

在隔离数据上通过重复通知、错误 ACK、断流、重启和恢复验证后，配置：

```dotenv
XINCHAO_BRIDGE_WEBHOOK_URL=https://你的AI接收端/xinchao/wake
XINCHAO_BRIDGE_WEBHOOK_TOKEN=<不同于机器令牌的独立凭据>
DRY_RUN=false
```

缺少 URL 或独立 Token 时，live 模式会拒绝启动，不会静默丢弃或提前确认消息。
`DRY_RUN=true` 即使有 Webhook 配置也不会投递或 ACK。

队列有 TTL 和容量上限，离线补投不是无限保存保证。默认通用 TTL 为 168 小时、
最多 500 条，部分自身信号会更快过期；持续监测并备份。

## 7. 回退

先将桥设回 `DRY_RUN=true` 或暂停新桥服务，停止实际消费；心潮桥配置恢复到
变更前值并只重启心潮。保留最新状态与队列备份，不用旧快照覆盖新产生的记录。
OB 不参与桥回退。整个方案不改变现有 MCP 代理写权限；shadow 和 OB 自动写入
开关不是所有 MCP 写工具的统一只读保护，另需后端权限改造。

## 本地验证

```bash
node --test
docker build --network=none --target test -t xinchao-bridge:test .
docker build --network=none --target runtime -t xinchao-bridge:runtime .
```

测试使用模拟上游与 Webhook，不使用生产 Token。Docker 用例还应对真实心潮镜像
的合成队列验证观察不消费、容器重建、严格 ACK 和队列持久化。

参考：[Zeabur Dockerfile](https://zeabur.com/docs/en-US/deploy/methods/dockerfile)、
[Zeabur 持久卷](https://zeabur.com/docs/en-US/operations/data/volumes)。
