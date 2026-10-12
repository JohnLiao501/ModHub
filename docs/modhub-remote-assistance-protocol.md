# ModHub 远程协助协议

## 客户端直接协助（默认）

双方在 ModHub 内使用 `/remote-assistance/direct`，无需账号或网页登录。协助者名称由本人填写，`verified:false`，不能证明真实身份。协助码十位数字、十分钟有效、一次性使用，仅用于连接；连接后的权限由双方独立的随机 32 字节凭据控制。服务端只存凭据摘要，客户端按加载器数据库和仓库身份保存，凭据不进入 URL、聊天或日志。

| 请求（以下路径均位于 `/remote-assistance/direct`） | 内容与响应 |
| --- | --- |
| `POST /invites` | `{token,requestId,displayName}` → `{invite,session:null}`；协助者请求前保存凭据和幂等编号。 |
| `GET /codes/:code` | 返回自填名称与期限；不消费邀请码，不创建会话，不发送诊断。 |
| `GET /invites/:id` | 协助者 Bearer → `{invite,session:null\|session}`，用于等待玩家连接。 |
| `POST /invites/:id/cancel` | 协助者 Bearer、`{}`；只取消尚未使用的邀请码。客户端重新生成前先取消旧码。 |
| `POST /sessions` | 玩家明确确认后提交 `{code,token,requestId,displayName?,description?}` → `{session}`；原子消费邀请并创建独立会话，相同内容重试返回原会话。 |
| `GET /sessions/:id?after=<seq>` | 对应角色 Bearer → `{session,messages,nextCursor}`；每页最多二十条，文字内联，指令和结果仅摘要。 |
| `GET /sessions/:id/messages/:messageId` | 对应角色 Bearer → `{message}`，按需读取完整指令或结果。 |
| `POST /sessions/:id/text` | 双方 Bearer、`{requestId,text}` → `{message}`；纯文本，最多4000字。 |
| `POST /sessions/:id/commands` | 协助者 Bearer、`{requestId,kind,payload}` → `{command}`；按下文五类指令校验，同时只允许一项待处理操作。 |
| `GET /sessions/:id/commands/:commandId` | 对应角色 Bearer → `{command}`。 |
| `POST /sessions/:id/commands/:commandId/claim` | 玩家 Bearer、`{digest,claimId}` → `{command}`；只允许活动会话，相同领取编号重试幂等。 |
| `POST /sessions/:id/commands/:commandId/result` | 玩家 Bearer、`{claimId,status,result}` → `{saved:true}`；已领取结果只允许活动会话回传；暂停时可拒绝未领取操作，使用空 `claimId` 和 `status:cancelled`。 |
| `POST /sessions/:id/pause`、`/resume` | 玩家 Bearer、`{}` → `{session}`；暂停操作处理，期间仍可收信和聊天。 |
| `POST /sessions/:id/verify` | 玩家 Bearer、`{solved:boolean}` → `{session}`；已验证解决时结案。 |
| `POST /sessions/:id/close` | 双方 Bearer、`{}` → `{session}`；结束后停止读取和写入，不撤销本机修改。 |

`session` 包含 `{id,status,role,helper,player,description,expiresAt,verification}`，状态为 `active|paused|closed`，角色由凭据判断。`message` 包含 `{id,seq,type,kind,digest,status,sender,commandId?,text?}`，类型为 `text|command|result`。文字、指令及结果共用递增序号；文字和指令按发送方与 `requestId` 幂等，结果按操作编号、`claimId` 和内容摘要幂等，同编号但内容不同返回冲突。名称最多80字，可选问题说明最多4000字，以 JavaScript 字符串长度计。名称和会话编号都不赋予权限。

邀约生成、查码和加入按 IP 限流；已鉴权请求按会话及角色限流。指令、结果及聊天共同计入10 MiB容量，指令仍为结果预留1 MiB，最多一百项。期限按会话独立计算，实际活动可更新七天期限，轮询不能续期；邀请码过期或清理不结束已建立的会话。会话清理只删除其自身记录，不依赖修复模板状态。

切页和返回帮助首页只卸载工作区，继续只读收信；重新载入后恢复会话与收信。后台不得领取操作、采集资料、上传结果或修改本机。旧预览与临时许可失效，必须返回工作区重新预览确认。已经开始的本机保存事务完成必要回读，异常保留待核验记录，不自动重放；敏感结果的补传同样须在前台确认。浏览器关闭后不收信，手机后台可能延迟。

前台正常每两秒收信，隐藏页面每三十秒收信，失败时退避。收信在输入期间只更新消息和会话状态，保留输入法、草稿及焦点；日志与源码详情保持原节点和阅读位置，聊天上翻时不自动跳至新消息。

文字聊天默认 Enter 发送、Shift+Enter 换行；输入法组合输入、重复按键、空白消息和发送期间不触发发送。发送失败保留草稿。进入工作区、查看详情、预览和处理操作后定位相应内容，关闭详情返回原消息入口；后台收信不改变外层阅读位置。前台主动操作失败使用游戏暗黑提示框，并保留本机红色错误及具体原因；结果回传完成不能覆盖本机执行失败，轮询错误不反复弹窗。

客户端通过 `modhub-remote-protocol.js`／`window.modHubRemoteProtocol` 共享五类内容校验、响应限额、脱敏和预览说明。新版工作区仅请求直接协助接口，不加载旧客户端或修复码模板。服务器历史记录按原保留期限清理，本次不删除数据或迁移历史会话。

`inspectCodeSources([{path,content}])` 是同步纯文本检查，返回 `{category,reason,path,line,excerpt}`。检查远程完整 JS，以及补丁生成包中实际修改后的完整声明文本，不按扩展名排除内嵌脚本。检查网络相关名称、本机存储、动态求值、页面或脚本注入和异步调度特征；每个文件与类别记录首次命中。命中仅表示可疑文本特征，注释和字符串也可能命中；未发现特征不代表安全，混淆代码可能漏报。

玩家在本机预览检查结果；执行前重新核验正文、包体与检查结果，命中后额外确认。取消不领取、不建点、不执行；确认仅对当前预览有效，切页、暂停或内容变化后须重新预览。源码、命中片段及检查详情留在本机，不增加服务端指令或结果字段。

## 操作及内容

`command = { id, seq, kind, payload, digest, status }`。digest 为服务端对 `JSON.stringify({kind,payload})` UTF-8 的 SHA-256 十六进制摘要；已发布内容不可修改。客户端重新计算摘要。状态为 `queued`、`claimed`、`completed`。摘要列表省略 payload。

- `runJavaScript`：`{summary,script,verification}`，仅直接协助分支接受；分别为非空字符串，最多 2000、16000、2000 字，保留 JS 正文和换行。服务端只保存与传输，不执行。玩家纯文本预览后明确确认；原生游戏存档保存到本机独立 IndexedDB，事务完成且回读一致、游戏状态和前台许可仍有效后，只运行一次纯 JS。源码与存档原文不作为结果上传。
- `collectDiagnostics`：`{ allLogs: boolean }`，在本机整理并预览报告，确认后发送；默认 false。
- `readSources`：`{ name, paths }`，仅目标模组已声明文件，最多二十个文件，单文件 256 KiB、源码合计 512 KiB。
- `applyPatch`：`{ name, version, baselineHash?, summary, evidence, verification, changes: [{path,before,after,reason}] }`，单包最多八个替换片段；精确技术名和版本，原文唯一匹配。可选 baselineHash 必须匹配本机包体。禁止 boot.json 和恢复工具/必要前置。保留已声明文本替换文件。
- `applyConfiguration`：`{ issueId }`，仅本机新鲜检查能生成的启用唯一前置或整理顺序方案；不接受远端启禁数组或存储键。

资料和补丁结果分别保存为消息行，每份最终 JSON 不超过 1 MiB。会话最多一百条指令和 10 MiB 资料；插入指令时为结果预留 1 MiB，保存结果原子释放差额。超限拒绝且不截断。分页列表最多二十条摘要，正文按单条读取。

## 快速指令与游戏备份

`modhub-game-command.js` 使用当前游戏的 `SugarCube.Scripting.evalJavaScript` 执行纯 JS，支持 `V`／`State.variables`，不通过 Wikifier 渲染宏。该模块预览做语法检查、状态与正文摘要，远程协助层再检查完整正文的本地文本特征；两项检查均不执行正文。游戏尚未开始、不能原生存档、备份失败、回读不一致、状态变化、离开或暂停时均不运行。JS 具有整页权限，不能作为受限沙箱；异步任务不受控，同步返回不代表修复完成。

远程配置修复、源码补丁和 JS 均先建立 `remoteRepair` 模组时间点，并在创建目录的同一事务设置 `userProtected:true`。关闭普通自动建点不跳过协助保护；保护失败则停止操作。JS 由远程协助执行层先保存模组时间点，再调用原有原生游戏备份流程，两项备份完成后才运行。模组时间点编号 `pointId` 保存在本机操作及历史记录中，JS 结果协议仍只包含下述原字段。

协助时间点持续保护，不因成功启动或协助结案自动解除；玩家核验后可在时间点面板选择该点并取消手动保护，随后参与普通历史清理，系统保护仍独立生效。模组时间点覆盖旁加载包及管理配置，原生 `.save` 覆盖游戏存档范围，不能互相代替。收尾等待回读并释放锁，失败保留备份及实际执行记录，显示待核验；任何备份均不能撤销已发生的数据外发，也不能阻止恶意同页代码破坏本机数据。

本机领取前持久登记 claimId，回读备份后且求值前登记 backupId 与 running 阶段。重载、轮询、失败或中断不重试脚本。结果 `saved` 仅表示同步求值结束且本机收尾完成，`verification:pending-game-check`；异常为 `failed`，中断或收尾失败无法核验时为 `uncertain`。结果只允许 `{message,backupId?,verification?}`；异常原文与求值结果仅在本机显示，避免自动分享游戏变量。玩家按验证方法检查，再自行保存游戏；结案不撤销已运行内容。

备份通过当前游戏原生 `Save.serialize()` 生成，遵循原生存档范围，不承诺包含当前段落的全部即时变化。它保存在 `modhub_game_command_backups`／`backups`，键为 `modhub-game-` 加游戏存储身份、会话和操作编号摘要，不覆盖游戏存档槽或已有操作备份。模块只在执行或下载时打开数据库。下载 `.save` 后从游戏原生存档界面导入；不通过模组时间点恢复游戏状态。浏览器本机数据被清除会丢失未下载备份。

社区言灵也可包含完整 SugarCube 宏文本；首版快速指令只接受纯 JS。语法和变量依据见 [SugarCube 脚本宏说明](https://www.motoslave.net/sugarcube/2/docs/#macros-macro-script)、[变量接口](https://www.motoslave.net/sugarcube/2/docs/#state-api-getter-variables)、[自定义魔法书列表源码](https://github.com/ZeroRing233/DOL-Custom-Spellbook-Mod/blob/master/src/tweeFileList/spellBookWidgets.twee#L429)。本地 DoL 0.5.12.13 核验为 SugarCube 2.36.1，因此沿用其实际原生存档接口。

## 公共言灵投稿

典型问题经玩家明确验证解决后，协助者可点击“整理为候选言灵”；言灵市场也提供主动投稿入口。入口只打开独立公开表单，可恢复用户此前主动填写的本机公开草稿，不带入会话、指令、聊天、诊断、源码、存档、私人变量或协助凭据。提交者自行整理名称、作者、正文、语法、输入位置、使用步骤、适用游戏及模组版本、前提条件、参数和验证方法，并明确确认公开内容已移除私人资料。原创候选不要求外部原帖链接，引用他人资料时仍应填写真实来源并遵守授权。

候选复用现有社区投稿、安全验证、限流、查询凭证、补充资料和人工审核流程，提交只进入审核队列，审核通过后才进入公共目录。`spell.submittedEnvironmentVerified` 表示提交者自述在所列环境验证，`spell.generalCompatibility` 固定为 `unverified`，不会把单个环境成功提升为通用适配结论；`gameTested` 保持 `false`，不代表审核者游戏实测。既有 `spell/spells` 索引、缓存及接口保持兼容，市场正文仍只展示和复制，不自动执行，不增加公共方案码或多人会话。

投稿正文是用户主动准备的公开资料，不提供自动脱敏保证。提交前须逐项核对，不要填入聊天原文、存档、访问令牌、API 密钥或包含私人变量值的代码。即使审核通过，文本检查仍可能漏报；完整 JS 拥有页面权限，执行前备份无法撤销已经发生的数据外发。
