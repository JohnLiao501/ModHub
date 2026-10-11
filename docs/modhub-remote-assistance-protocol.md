# ModHub 远程协助协议（v1）

开发者入口为既有 Worker 的 `/assist`，开发者 API 为 `/assist/api`，玩家 API 为 `/remote-assistance`。所有响应为 JSON 且禁止缓存；错误为 `{ error, details? }`。时间使用 Unix 毫秒。公开身份仅使用开发者显示名和稳定标识，不公开登录邮箱。游戏服务地址固定使用既有市场 Worker，不能由修复码指定。

## 操作及内容

`command = { id, seq, kind, payload, digest, status }`。digest 为服务端对 `JSON.stringify({kind,payload})` UTF-8 的 SHA-256 十六进制摘要；已发布内容不可修改。客户端重新计算摘要。状态为 `queued`、`claimed`、`completed`。摘要列表省略 payload。

- `collectDiagnostics`：`{ allLogs: boolean }`，在本机整理并预览报告，确认后发送；默认 false。
- `readSources`：`{ name, paths }`，仅目标模组已声明文件，最多二十个文件，单文件 256 KiB、源码合计 512 KiB。
- `applyPatch`：`{ name, version, baselineHash?, summary, evidence, verification, changes: [{path,before,after,reason}] }`，单包最多八个替换片段；精确技术名和版本，原文唯一匹配。可选 baselineHash 必须匹配本机包体。禁止 boot.json 和恢复工具/必要前置。保留已声明文本替换文件。
- `applyConfiguration`：`{ issueId }`，仅本机新鲜检查能生成的启用唯一前置或整理顺序方案；不接受远端启禁数组或存储键。

资料和补丁结果分别保存为消息行，每份最终 JSON 不超过 1 MiB。会话最多一百条指令和 10 MiB 资料；插入指令时为结果预留 1 MiB，保存结果原子释放差额。超限拒绝且不截断。分页列表最多二十条摘要，正文按单条读取。

## 玩家 API

- `GET /repairs/:code` → `{ repair: { id, code, title, description, helper, expiresAt, initialCommand: {kind,payload,digest} } }`。
- `POST /sessions`，正文 `{ code, token, requestId }` → `{ session, continuationCode, command }`。玩家先在本机持久保存随机 32 字节十六进制 token 和 requestId；服务端仅保存 token 摘要，以 requestId+token 幂等建会话。初始 command 独立复制。此步骤须玩家确认加入。
- 以下请求使用 `Authorization: Bearer <token>`，禁止 Cookie，token 不放 URL。
- `GET /sessions/:id?after=<seq>` → `{ session, messages, nextCursor }`。session 为 `{ id, repairId, repairCode, helper, status, pairing, expiresAt, verification }`；status 为 `active|paused|closed`，pairing 为 `unpaired|pending|paired`。messages 为指令/结果摘要，含 id、seq、type、kind、digest、status。没有正文。
- `GET /sessions/:id/commands/:commandId` → `{ command }`。
- `POST /sessions/:id/pair`，`{ accept: boolean }` → `{ session, continuationCode? }`，只有 pending 可接受；拒绝回到 unpaired 并返回新续接码。unpaired 时 accept=false 可重新生成续接码，原码立即失效；paired 不允许重生。续接码有效十分钟，配对完成前开发者不能读取结果。
- `POST /sessions/:id/pause` 或 `/resume`，`{}` → `{ session }`。pause 不结案；resume 必须玩家主动点击，不能恢复旧确认。
- `POST /sessions/:id/commands/:commandId/claim`，`{ digest, claimId }` → `{ command }`。玩家先持久登记 claimId，再请求；相同 claimId 重试幂等。领取核验身份、所有者资格、期限、active 状态和未撤销修复码。初始指令允许未配对领取，后续指令必须 paired。
- `POST /sessions/:id/commands/:commandId/result`，`{ claimId, status, result }` → `{ saved: true }`。status 为 `sent|saved|cancelled|failed|uncertain`；成功修改 result 包含 pointId、verification（待重载），不上传令牌和完整 prepared。相同结果幂等，不同重复结果拒绝。取消未领取指令可使用空 claimId。
- `POST /sessions/:id/verify`，`{ solved: boolean }` → `{ session }`，记录玩家重载后判断；solved=true 同时结案。
- `POST /sessions/:id/close`，`{}` → `{ session }`。

## 开发者 API

所有接口复用独立 Access 身份并每次核验 SUPPORT_EMAILS；写请求必须同源。只可操作本人的修复方案。

- `GET /identity` → `{ helper }`。
- `GET /repairs?cursor=<cursor>` → `{ repairs,nextCursor }`，每页最多二十条摘要。
- `POST /repairs`，`{ title, description, initialCommand: {kind,payload} }` → `{ repair }`；生成八位数字 code，发布后不修改原方案。
- `POST /repairs/:id/delete`，`{}` → `{ deleted:true }`；关联会话失效。
- `POST /repairs/:id/pair`，`{ code: <十位续接码> }` → `{ session }`；仅本人方案，单次兑换，等待玩家确认。
- `GET /repairs/:id/sessions?cursor=<cursor>` → `{ sessions,nextCursor }`，每页最多二十条，只返回已配对或待确认会话的非敏感摘要。
- `GET /sessions/:id?after=<seq>` → `{ session,messages,nextCursor }`；正文仅已配对允许读取。
- `GET /sessions/:id/messages/:messageId` → `{ message }`；message 包含原指令或结果正文。
- `POST /sessions/:id/commands`，`{ requestId, kind,payload }` → `{ command }`；requestId 幂等，必须 paired，但允许玩家暂停时排队。
- `POST /sessions/:id/close`，`{}` → `{ session }`。

## 状态与隐私

修复码及会话闲置七天到期，实际用户操作可续期，轮询不能续期。后续操作不能因配对成功自动确认。撤销拒绝后续领取；已开始的本地事务完成回读后保存本地结果，不宣称撤销成功。执行中断标为待核验，不自动重放。关闭、删除、过期的资料立即不可读，定时清理正文。结果记录与源码不进入公开目录及应用日志。

服务端原子领取与客户端本地执行记录共同防止重复提交；不宣称跨网络和本地存储具有分布式事务。玩家关闭页面后重新进入必须手动继续；凭据与记录按加载器数据库和仓库身份隔离。
