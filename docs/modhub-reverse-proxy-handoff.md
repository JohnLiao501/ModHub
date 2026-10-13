# ModHub 国内接口反代配置交接

请将 `https://dol.alseece.top` 从市场索引入口扩展为 ModHub 的公开业务接口入口。浏览器连接该域名，由服务器回源现有 Worker；模组包体、协助会话和社区资料继续由原服务维护。

公共配置见 [宝塔增量配置](modhub-nginx/README.md)；下文通用 Nginx 示例用于说明契约，不与增量文件重复加载。站点已经安装公共配置，本次只需替换空凭据行、放置单独提供的私有凭据文件，并新增一条网站精确路径规则，不要求重新上传整套配置。

宝塔 proxy 目录存在索引精确规则，增量文件已排除重复的 `/release-index.json` 声明。IPv4 和系统 CA 回源修正后的公开接口复测已通过；保留旧索引 location 对 `modhub-worker.inc` 的引用。将公共文件原来的空 `X-ModHub-Proxy-Token` 行替换为 `include /www/server/panel/vhost/nginx/extension/dol.alseece.top/modhub-proxy-auth.inc;`，放置私有文件，并按下文新增 `/modhub/index.html` 的精确规则，`nginx -t` 成功后再平滑重载。

2026 年 10 月 13 日，用户确认在其直连网络中 Cloudflare 内容及投稿安全验证均无法加载，并明确决定继续使用 Turnstile。本次接入范围包括公开 API、网站页面和静态资源，以及现有 Turnstile 的公开域名和后端校验适配。仅扩展 API 反代不能解决 Turnstile 的浏览器依赖。

客户端的公开接口代码适配已完成，网站及后端已发布，现有 Turnstile 的公开允许域名已追加并回读确认。仍待管理员放置私有 include、替换空凭据行、新增网站精确路径规则并确认成功重载，再验收多人协助与社区投稿。国内关闭 VPN 后的完整验证码及游戏流程尚未验收，不能将发布或接口检查通过表述为全功能国内直连通过。

## 公开路径与上游

下表中的路径必须保持原样，完整保留查询参数。Worker 上游为 `https://dolmod-release-index.johnliao381658675.workers.dev`。

| 公开路径 | 方法 | 覆盖功能 |
| --- | --- | --- |
| `/release-index.json` | GET | 市场目录、版本索引、社区条目安装前核验 |
| `/mod-releases` | GET | 历史版本、兼容证据、版本专属前置 |
| `/readme` | GET | 在线模组说明 |
| `/readme-image` | GET | 已受支持的 GitHub 说明图片 |
| `/download` | GET | 自建 GitHub 安装包下载通道 |
| `/remote-assistance` 及其子路径 | GET、POST、OPTIONS | 当前双向协助 `/remote-assistance/direct/*`，以及旧版玩家接口 |
| `/community-challenge` | GET | 投稿安全验证页面 |
| `/community-submissions` | POST、OPTIONS | 模组与言灵投稿、纠错和下架申请 |
| `/community-submissions/query` | POST、OPTIONS | 查询自己的投稿 |
| `/community-submissions/query-batch` | POST、OPTIONS | 批量查询自己的投稿 |
| `/community-submissions/target-status` | POST、OPTIONS | 查询同一目标的申请状态 |
| `/community-submissions/amend` | POST、OPTIONS | 补充资料 |
| `/community-submissions/withdraw` | POST、OPTIONS | 撤回投稿 |
| `/community-submissions/delete` | POST、OPTIONS | 删除允许自行删除的投稿 |
| `/health` | GET | 检查服务及索引状态 |

另提供 `GET /mod-identities.json`，上游单独使用 `https://dolmod-catalog-pages.pages.dev/mod-identities.json`。这是身份字典，当前 Worker 没有此路由，不能将它回源到 Worker。

公共代理规则只覆盖上述路径。`/admin`、`/admin/*`、旧开发者页面 `/assist` 和 `/assist/*` 继续使用原有 Cloudflare Access 保护；它们涉及登录、回跳和同源校验，需要独立部署方案。当前双向协助的双方均在 ModHub 内使用 `/remote-assistance/direct/*`。

## 服务器配置要求

1. 使用有效 HTTPS 证书。服务器自身必须能够直连 Worker 和身份字典上游，并验证上游证书。
2. 回源 Worker 时将 Host 和 TLS SNI 都设为 Worker 域名。保留路径与查询参数，避免添加末尾斜杠重定向；协助客户端明确拒绝重定向。
3. 原样传递 POST 正文、`Authorization`、`Content-Type` 和 `Origin`。本地游戏可能使用 `Origin: null`，不能仅因这一来源而拒绝请求。不要把 Origin 改写成 Worker 域名。
4. 由 Worker 返回 CORS 响应，代理不要追加另一套重复头。特别保留 `Access-Control-Allow-*`、`Access-Control-Expose-Headers`、`X-ModHub-Community-Fresh`、`Retry-After`、`X-RateLimit-*`、`Content-Length` 和 `Content-Disposition`。
5. 首次上线关闭这些路径的代理缓存，并保留上游 Cache-Control。协助、投稿、健康检查和索引的新鲜状态不可由旧响应代替。现有索引规则也要一起核对：安装前要求 `X-ModHub-Community-Fresh: 1`，静态镜像不能伪造该头。
6. 不拦截上游 JSON 错误，不将 4xx/5xx 改成成功页，不为 POST 自动重试。下载流式转发，避免把大包完整写入代理临时文件。
7. 请求正文上限可设为 1 MiB。Worker 继续执行更细的限制：远程 JSON 最多 1 MiB；新建和补充投稿最多 512 KiB，其余投稿接口最多 16 KiB。请求上限不限制下载响应；现有 Worker 最大下载包为 256 MiB，说明图片为 8 MiB。
8. 协助和投稿路径关闭普通访问日志，不记录请求正文、Authorization 或代理密钥，不开启生产调试日志。会话凭据不能放进 URL。保留必要的错误监控，并限制日志访问。

如果域名前方还有 CDN 或 WAF，也要核对相同路径的缓存、预检和浏览器挑战规则，避免 Nginx 已转发但请求仍在更前一层被拦截。

## Nginx 配置示例

以下内容加入现有 `dol.alseece.top` 的 HTTPS server。若使用宝塔，同样编辑该站点的 Nginx 配置。先核对已有 location 的优先级，合并或替换同路径的旧规则，保留网站其他页面。

此示例中的两个代理请求头已由线上 Worker 实现，`MODHUB_PROXY_SECRET` 已设置并回读确认，服务器私有 include 的放置和重载仍待确认。目标服务器为 Alibaba Cloud Linux 3，CA 使用已验证的系统证书包路径。相关 location 以变量上游配合 ipv6=off 限制 IPv4 回源；现有已验证的 DNS 和 CA 配置继续保留。

```nginx
location ~ ^/(release-index\.json|mod-releases|readme|readme-image|download|health|community-challenge|community-submissions(/(query|query-batch|target-status|amend|withdraw|delete))?|remote-assistance(/.*)?)$ {
    resolver 223.5.5.5 223.6.6.6 ipv6=off valid=300s;
    resolver_timeout 5s;
    set $modhub_worker_upstream dolmod-release-index.johnliao381658675.workers.dev;
    proxy_pass https://$modhub_worker_upstream;
    proxy_redirect off;
    proxy_http_version 1.1;
    proxy_set_header Host dolmod-release-index.johnliao381658675.workers.dev;
    proxy_set_header Connection "";
    proxy_set_header Authorization $http_authorization;
    proxy_set_header Content-Type $http_content_type;
    proxy_set_header Origin $http_origin;
    proxy_set_header Cookie "";

    proxy_ssl_server_name on;
    proxy_ssl_name dolmod-release-index.johnliao381658675.workers.dev;
    proxy_ssl_verify on;
    proxy_ssl_verify_depth 3;
    proxy_ssl_trusted_certificate /etc/pki/tls/certs/ca-bundle.crt;

    # 覆盖访客自行提交的同名头，密钥由受限配置文件提供。
    proxy_set_header X-ModHub-Proxy-Client-IP $remote_addr;
    include /www/server/panel/vhost/nginx/extension/dol.alseece.top/modhub-proxy-auth.inc;

    client_max_body_size 1m;
    proxy_connect_timeout 10s;
    proxy_read_timeout 120s;
    proxy_send_timeout 60s;
    proxy_request_buffering off;
    proxy_buffering off;
    proxy_force_ranges off;
    proxy_cache off;
    expires off;
    proxy_intercept_errors off;
    proxy_next_upstream off;
    access_log off;
}

location = /mod-identities.json {
    resolver 223.5.5.5 223.6.6.6 ipv6=off valid=300s;
    resolver_timeout 5s;
    set $modhub_pages_upstream dolmod-catalog-pages.pages.dev;
    proxy_pass https://$modhub_pages_upstream;
    proxy_redirect off;
    proxy_http_version 1.1;
    proxy_set_header Host dolmod-catalog-pages.pages.dev;
    proxy_set_header Connection "";
    proxy_set_header Authorization "";
    proxy_set_header Cookie "";
    proxy_ssl_server_name on;
    proxy_ssl_name dolmod-catalog-pages.pages.dev;
    proxy_ssl_verify on;
    proxy_ssl_verify_depth 3;
    proxy_ssl_trusted_certificate /etc/pki/tls/certs/ca-bundle.crt;
    proxy_connect_timeout 10s;
    proxy_read_timeout 60s;
    proxy_cache off;
    expires off;
    proxy_intercept_errors off;
}
```

`modhub-proxy-auth.inc` 由我们单独提供，只交给服务器管理员，包含与 Worker 的 `MODHUB_PROXY_SECRET` 对应的一条代理凭据配置。该文件仅供 Nginx 和管理员读取，不公开、不提交仓库、不进入客户端包或公共附件；不要发送完整配置输出或将密钥写入访问日志。私有文件放置后，必须先检查配置再重载。`proxy_pass` 后面没有 URI 部分，是为了保留原路径和查询参数。[Nginx 官方配置说明](https://nginx.org/en/docs/http/ngx_http_proxy_module.html)

如果 Nginx 前还有其他代理，`$remote_addr` 起初可能是前置代理地址。服务器管理员应只对明确可信的前置代理配置 real_ip，恢复真实访客地址后再转发；不能信任任意访客传入的 X-Forwarded-For。

## ModHub 后端配套修改

### 真实用户 IP 和多人限流

Worker 的历史、下载、投稿及远程协助限流已经统一接入可信代理上下文。未通过代理校验时仍使用 Cloudflare 提供的直连 IP；普通 Nginx 回源但未配置有效代理凭据时，多位玩家仍会共用出口额度。远程协助的正常轮询也经过 IP 限流，不能只提高生成协助码的限额。

线上 Worker 已实现以下契约，服务器私有 include 生效及多人实际限流仍待验收：

- Worker 使用受保护环境密钥 `MODHUB_PROXY_SECRET` 验证 `X-ModHub-Proxy-Token`。
- 只有代理密钥验证通过，才接收并校验单个 `X-ModHub-Proxy-Client-IP`，用于所有上述限流及投稿验证的 remoteip。无效代理头必须拒绝或忽略，不能让访客伪造 IP 绕过限流。
- 普通直连请求继续使用 Cloudflare 提供的 IP。Nginx 用自己的实际访客地址覆盖同名代理头，不转发访客提供的密钥。
- 代理密钥只授权转发身份，不赋予协助会话、投稿或后台权限；Bearer、查询凭证、逐项确认和原有限流仍须验证。

设置 `X-Forwarded-For` 或自行覆盖 `CF-Connecting-IP`，都不能替代这项适配。Cloudflare 对进入其网络的客户端 IP 有自己的处理规则。[Cloudflare 请求头说明](https://developers.cloudflare.com/fundamentals/reference/http-headers/)

### 投稿和言灵安全验证

按用户决定，继续使用现有 Turnstile，不新增其他验证码服务。验证页面仍通过官方脚本访问 `challenges.cloudflare.com`，代理 `/community-challenge` 不会消除这条浏览器依赖。[Turnstile 官方接入说明](https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/)

服务维护者已在现有 Turnstile 组件的允许域名中追加并回读确认 `dol.alseece.top`。原 Worker 域名、模式和 clearance 保持不变，未读取或替换 Turnstile secret。允许域名使用纯域名，不附带协议、端口或路径。[Turnstile 域名配置说明](https://developers.cloudflare.com/turnstile/additional-configuration/hostname-management/)

后端代码已对通过代理凭据和 IP 校验的请求使用固定公开域名 `dol.alseece.top` 核验令牌 hostname；普通直连继续核验请求原 hostname。继续要求 `success === true` 和 `action: community_submit`，不信任 X-Forwarded-Host，也不删除域名校验。

客户端已同步调整验证 iframe 地址、提交地址和消息来源检查，保留 iframe 来源及 nonce 校验。现有票据验证、密钥保护及页面 CSP 继续保留，不自行镜像或改写官方验证脚本。

验收覆盖验证资源加载、完成验证、票据校验、过期或伪造票据拒绝及服务不可用时的明确提示。若玩家网络仍无法访问 `challenges.cloudflare.com`，投稿及补充资料仍可能无法完成，不能将反代入口成功表述为已解决这条依赖，也不能关闭验证直接放行。普通市场读取、下载和当前远程协助不依赖投稿验证码，可以独立联调。

## 网站页面与静态资源

网站 Pages 页面也需要国内入口。建议在同一站点提供独立路径，例如 `/modhub/`，保留当前根目录页面。完整转发页面及其相对路径下的 JavaScript、SVG 和身份 JSON；也可以在该路径托管已发布的静态文件，但必须随网站发布同步更新。

以下为反代 Pages 的补充示例，加入同一 HTTPS server；访问入口使用带末尾斜杠的 `/modhub/`。变量 proxy_pass 不带 URI；白名单核验后以 rewrite ... break 移除该前缀，查询参数继续保留。赋值必须先于 break，不能改用 last。

线上发现上游 `/index.html` 会以 308 规范化到 `/?query`，直接传回会使 `/modhub/index.html` 落到站点根目录。管理员在现有 `modhub.conf` 的 `/modhub/` 静态段附近新增下面的精确 location，与原前缀 location 并列。这条规则保留查询参数并直接返回公开入口，不回源 Pages；不改其他 `proxy_redirect` 或业务规则。当前只完成本地配置修订，服务器仍待应用并执行 `nginx -t`。

```nginx
location = /modhub/index.html { return 308 /modhub/$is_args$args; }

location ^~ /modhub/ {
    resolver 223.5.5.5 223.6.6.6 ipv6=off valid=300s;
    resolver_timeout 5s;
    set $modhub_pages_upstream dolmod-catalog-pages.pages.dev;
    if ($uri !~ "^/modhub/(index[.]html|dol-mod-extractor[.]js|modhub-market-variants[.]js|modhub-wiki-title[.]js|mod-identities[.]json|modhub-access-logo[.]svg)?$") {
        return 404;
    }
    rewrite ^/modhub/(.*)$ /$1 break;
    proxy_pass https://$modhub_pages_upstream;
    proxy_redirect off;
    proxy_http_version 1.1;
    proxy_set_header Host dolmod-catalog-pages.pages.dev;
    proxy_set_header Connection "";
    proxy_set_header Authorization "";
    proxy_set_header Cookie "";
    proxy_ssl_server_name on;
    proxy_ssl_name dolmod-catalog-pages.pages.dev;
    proxy_ssl_verify on;
    proxy_ssl_verify_depth 3;
    proxy_ssl_trusted_certificate /etc/pki/tls/certs/ca-bundle.crt;
    proxy_connect_timeout 10s;
    proxy_read_timeout 60s;
    proxy_cache off;
    expires off;
    proxy_intercept_errors off;
}
```

网页中的索引、历史 API 和受支持的 GitHub 安装包链接已切换到国内入口及既有 `/download`，Pages 生产发布和原 Sites 公开入口的 `/modhub/` 跳转发布均已确认成功。原始出处链接继续保留，页面跳转本身不能替代后端反代。

## 客户端和网站的代码适配范围

| 位置 | 改动范围 |
| --- | --- |
| `src/javascript/modhub-remote-assist.js` | 协助 API 已改为公开入口；双方仍连接同一现有服务 |
| `src/javascript/modhub-market.js` | 已同步动态 API、安装前索引核验、说明和图片、下载、社区接口、验证 iframe 及身份 JSON 地址 |
| `src/javascript/modhub-market-versions.js` | 历史接口已使用公开业务入口；保留 GitHub 官方回退和本机缓存边界 |
| `dol-mod-extractor.js` 与 `dolmod-site/dist/dol-mod-extractor.js` | 已统一网站历史版本 API 基址 |
| `dolmod-site/dist/index.html` | 已同步网站索引和受支持的下载链接 |

市场的 `fetchModRelease` 和 `fetchRecentCompanionAssets` 已优先复用受约束的 Worker 发布服务，覆盖批量安装、单项安装、固定标签、共享仓库与附属包查询。保留既有官方回退及本机缓存边界，没有新增接受任意 URL 的通用 GitHub API 代理。线上仍须按这些实际流程验收。

切换时保留既定的索引、最后成功缓存、Wiki 和内置别名回退链。任何跨入口自动重试，尤其带正文的请求，都须核验同一后端和幂等编号，不能因超时重复执行操作。

## 其他模块及残余外部依赖

| 模块或依赖 | 处理方式 |
| --- | --- |
| AI 分析与修复 | 直接访问用户填写的 HTTPS API，携带用户 API 密钥；项目公共反代不能自动覆盖。选择国内可达且允许浏览器 CORS 的服务即可。若另建 AI 中转，需要独立可信上游、授权及密钥保护；DeepSeek 的服务识别也要相应处理 |
| 模组管理、排序、日志、美化、时间点还原 | 本地功能，无需新增反代 |
| Wiki 与 GitHub 官方回退 | 保留原有容错；主接口正常时减少玩家直连这些服务的需求 |
| DDLC、Boki 下载线路 | 保留既有下载选择及失败切换，仅用于公开安装包，不用于协助或 AI 凭据 |
| README 内其他作者外链图片和动态徽章 | 现有受限图片代理、包内图片和本地 SVG 可覆盖部分资源；其余图片仍依赖各自源站 |
| 作者主页、贴吧、Discord 等原始来源链接 | 保留真实链接，外部网站是否能在国内打开不由 ModHub 入口保证 |
| 网站与 Sites 入口 | 页面、API、受支持的下载链接及 Sites 跳转已完成发布；国内完整浏览与下载流程仍待实测 |

## 联调与上线验收

现有公开反代已完成接口复测，后端、网站及 Turnstile 域名配置已完成发布和回读确认。此次服务器只需替换空凭据行、放置私有 include，并新增 `/modhub/index.html` 精确规则；变更前保留原配置，执行 `nginx -t`，通过后再平滑重载。上述增量修改与管理员重载仍待确认。

以下命令只检查公开 GET 和 OPTIONS，不发送会话凭据，也不创建协助或投稿：

```bash
curl -i --max-time 20 'https://dol.alseece.top/health'
curl -i --max-time 20 'https://dol.alseece.top/release-index.json'
curl -i --max-time 20 'https://dol.alseece.top/mod-identities.json'
curl -i --max-time 20 'https://dol.alseece.top/community-challenge?nonce=modhub-proxy-test&embedded=1'
curl -i --max-time 20 -X OPTIONS \
  'https://dol.alseece.top/remote-assistance/direct/invites' \
  -H 'Origin: null' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: authorization,content-type'
curl -i --max-time 20 -X OPTIONS \
  'https://dol.alseece.top/community-submissions/query' \
  -H 'Origin: null' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: content-type'
```

健康检查和两个 JSON 文件应返回 200 及对应内容，健康状态需另检查 `ok` 和新鲜程度。索引须正确保留新鲜状态响应头；验证页应返回 HTML，浏览器中实际完成验证；两个 OPTIONS 应返回 204 并包含正确 CORS 头。接口不能返回登录页面、重定向或 Nginx 默认错误页。

联调最后用双方自己的隔离协助会话验证：生成码、加入、收信、聊天、重新载入续接、暂停和结束；结束后旧凭据无法读取。检查至少两位实际访客的 IP 限流相互独立，伪造代理头无效。不以执行真实游戏修改作为连通性验证。

市场同时验收历史分页、固定标签和共享仓库选包、说明及图片、完整 ZIP 下载、安装前社区状态核验。当前 Worker 下载服务没有实现 Range 断点续传，代理不要伪造 206 或开启强制分段来宣称已支持断点续传。

投稿验收现有 Turnstile 在公开域名上的完整流程、创建、查询、补充和撤回，并清理隔离测试资料。网站另外验收页面、配套静态资源、数据刷新、历史查询和下载，确认普通使用不会再跳回 `pages.dev` 或直接请求 `workers.dev`；Turnstile 官方资源仍是独立外部依赖。管理员完成私有 include 并确认成功重载后，国内关闭 VPN 分别测试桌面和手机网络，确认多人轮询及实际验证。客户端或 Worker 改动后运行 `node src/test-smart-sort.js`；网站改动运行 `npm test`；涉及根提取器时另运行 `node test-dol-mod-extractor.js`，并完成改动文件的 Python Unicode 扫描。

## 当前探测与代码定位

2026 年 10 月 13 日首次加载扩展前，主域 `/health`、`/community-challenge` 和 `/mod-identities.json` 返回 404；协助邀约及投稿查询的 OPTIONS 返回 405。重启后，页面、配套 JS 和身份字典已返回 200，协助预检曾返回 204；健康检查仍在 200 和 502 之间交替，投稿预检返回 502。

用户提供的服务器错误日志曾确认 IPv6 上游不可达及证书链 verify 20。使用 IPv4 变量上游和目标系统 CA 包修正后，健康连续检查、索引、历史、说明、页面资源、完整下载包校验及两类预检均已通过。后续代码适配已完成并通过本地自动化验证，发布状态如下：

| 组件 | 已核验状态 |
| --- | --- |
| Worker | 版本 `5e8f4ca4-0101-4afb-be86-bd1e0086d51a` 已上线；`MODHUB_PROXY_SECRET` 已设置，原绑定回读保留 |
| Pages | 生产版本 `3fd45293` 已发布 |
| Sites | 原公开入口版本 `25` 发布状态为 `succeeded`；已同步当前生产源码及关联测试 |
| Turnstile | 原组件已追加并回读 `dol.alseece.top`；原 Worker 域名、模式及 clearance 保持不变，未读取或替换 Turnstile secret |

发布前后 `community_entries` 为 38、`community_submissions` 为 53、`community_submission_events` 为 112，其他相关表计数也完全相同；外键检查为 0，无需数据库迁移。管理员放置私有 include、替换空凭据行、新增网站精确规则及成功重载仍待确认；`/modhub/index.html` 跳转问题尚未在服务器修复，国内无 VPN 的完整验证码及游戏流程尚未验收。

早期使用默认脚本请求头时，主域索引及 Worker 健康接口另收到 403，正文为 `error code: 1010`；改用 curl 请求头后 Worker 健康检查返回 200。Cloudflare 将 1010 解释为客户端浏览器签名被拒绝，这不能单独证明普通玩家浏览器也无法访问。若服务器回源仍收到此错误，由服务维护者根据安全事件精确处理公开 API 的可信来源规则，保留其他路径保护。[Cloudflare 1010 错误说明](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1010/)

上述 HTTP 探测不是国内关闭 VPN 的游戏实测，也未创建会话或投稿。

代码定位：

- 客户端公开接口、身份地址、投稿来源检查和安装前新鲜索引：`src/javascript/modhub-market.js`。
- 发布资料主流程：同文件的 `fetchModRelease` 与 `fetchRecentCompanionAssets`；历史接口与回退边界：`src/javascript/modhub-market-versions.js`。
- 协助请求与轮询：`src/javascript/modhub-remote-assist.js`；两种协助共用限流：`dolmod-site/modhub-remote-assistance.js` 与 `dolmod-site/modhub-direct-assistance.js`。
- 后端可信代理上下文：`dolmod-site/modhub-proxy-context.js`；公共路由、其他 IP 限流、Turnstile 校验与验证页：`dolmod-site/release-worker.js`。
- 网站地址：`dolmod-site/dist/index.html`；提取器接口：`dol-mod-extractor.js` 及其网站副本；Sites 页面跳转：`dolmod-site/dist/server/index.js`。
