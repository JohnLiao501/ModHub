# ModHub 宝塔站点增量配置

本目录保存适用于 `dol.alseece.top` 宝塔主配置的公共配置。站点已安装 `modhub.conf` 和 `modhub-worker.inc`；本次只需替换空凭据行、放置单独提供的私有凭据文件，并新增一条网站精确路径规则，无需重新上传整套配置。主配置通过 `extension/dol.alseece.top/*.conf` 加载扩展，文件所在目录为：

```text
/www/server/panel/vhost/nginx/extension/dol.alseece.top/
```

`modhub.conf` 自动加载；`modhub-worker.inc` 只被业务 location 引用，不会被 `*.conf` 重复加载。主配置的证书、HTTPS 跳转、根目录、PHP、错误页及敏感文件保护继续保留。不要把这里的配置与原交接说明中的通用示例重复加载。

IPv4 和系统 CA 修正版已用于处理实际日志中的 IPv6 回源不可达及证书链校验失败，目标服务器为 Alibaba Cloud Linux 3。原 `proxy/dol.alseece.top/` 目录已有 `location = /release-index.json`，保留这一条 location，并确认它已经引用公共配置，不另建第二条同路径规则：

```nginx
location = /release-index.json {
    include /www/server/panel/vhost/nginx/extension/dol.alseece.top/modhub-worker.inc;
}
```

`modhub.conf` 仍不重复声明索引。索引复用公共配置后，也会使用 IPv4、上游证书验证及无缓存转发。旧规则中的 Upgrade、Connection、缓存和 proxy_pass 等指令不要与新 include 并存。

## 加载前的必要检查

先备份站点主配置、现有 extension 配置、proxy 配置和伪静态配置。检查以下被引用的文件，不要直接关闭整个目录的 include：

```text
/www/server/panel/vhost/nginx/extension/dol.alseece.top/*.conf
/www/server/panel/vhost/nginx/proxy/dol.alseece.top/*.conf
/www/server/panel/vhost/rewrite/dol.alseece.top.conf
```

如果其他接口已有相同的精确路径或相同前缀 location，先将对应规则合并，不要重复新增。已有 `/release-index.json` 规则按上文替换内容，当前增量文件已排除该重复段。其他业务代理继续保留。若有更长的远程前缀，需一起核对。

精确路径和远程独立前缀用于避免后面的 PHP 或静态缓存规则接管请求。server 层伪静态 rewrite 仍可在 location 选择前改写路径，若命中这些接口，需从该 rewrite 中排除。也要检查继承的公共 Cache-Control、CORS、认证或来源限制，不能与 Worker 响应冲突。[Nginx 路径匹配说明](https://nginx.org/en/docs/http/ngx_http_core_module.html#location)、[rewrite 执行顺序](https://nginx.org/en/docs/http/ngx_http_rewrite_module.html)

这份主配置的 HTTP 跳转可以保留，客户端直接使用 HTTPS；`proxy_intercept_errors off` 用于保留 Worker 返回的 JSON 错误，避免上游 404 被替换为本地 `/404.html`。Nginx 自己产生的错误仍可能为 HTML。

## IPv4 回源、CA 与代理密钥

日志中的 `connect() to [2606:...] failed (101: Network is unreachable)` 表明本机没有可用的 IPv6 上游连接。配置在相关 location 中使用变量域名和 `resolver ... ipv6=off`，仅以 IPv4 回源，不关闭系统 IPv6，不固定 Cloudflare IP。只给静态域名 proxy_pass 添加 resolver 不能完成这项修复。[Nginx resolver](https://nginx.org/en/docs/http/ngx_http_core_module.html#resolver)、[变量 proxy_pass](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_pass)

DNS 示例使用阿里公共 DNS 的 `223.5.5.5` 和 `223.6.6.6`。管理员须确认服务器可以访问其 DNS 服务，或将三处 resolver 地址换为已验证的可信 DNS，保留 `ipv6=off`。可用已安装的 dig 检查两个地址对 Worker 和 Pages 域名的 A 记录解析；不要以全局 DNS 修改替代这三处配置。[阿里公共 DNS](https://alidns.com/)

另一条 `upstream SSL certificate verify error: (20:unable to get local issuer certificate)` 是独立的证书链问题。当前三处 `proxy_ssl_trusted_certificate` 已改为 Alibaba Cloud Linux 3 所属 RHEL 系统常用的 `/etc/pki/tls/certs/ca-bundle.crt`。部署前确认该文件真实可读，且能验证两个上游；不能使用本站 fullchain.pem 代替系统 CA 包，也不关闭 `proxy_ssl_verify on`。[RHEL 系统 CA 包](https://www.redhat.com/en/blog/configure-ca-trust-list)

在服务器先执行：

```bash
rpm -q ca-certificates
test -r /etc/pki/tls/certs/ca-bundle.crt && grep -c 'BEGIN CERTIFICATE' /etc/pki/tls/certs/ca-bundle.crt
curl -4 -i --max-time 20 -A 'curl/8.13.0' --cacert /etc/pki/tls/certs/ca-bundle.crt 'https://dolmod-release-index.johnliao381658675.workers.dev/health'
curl -4 -i --max-time 20 -A 'curl/8.13.0' --cacert /etc/pki/tls/certs/ca-bundle.crt 'https://dolmod-catalog-pages.pages.dev/mod-identities.json'
```

两个 curl 应返回有效 JSON 和 200，且没有证书校验错误。证书数量仅确认文件有内容，不能证明信任链有效。若未安装 ca-certificates，使用 `dnf install ca-certificates`；若已安装但过旧，使用 `dnf upgrade ca-certificates`。随后执行 `update-ca-trust extract` 并重新验证，只处理 CA 包，不更新整个系统。若验证仍失败，回传具体错误并检查上游证书链，不添加来源不明的根证书。

在服务器现有的 `modhub-worker.inc` 中，将下面这一行：

```nginx
proxy_set_header X-ModHub-Proxy-Token "";
```

替换为：

```nginx
include /www/server/panel/vhost/nginx/extension/dol.alseece.top/modhub-proxy-auth.inc;
```

`modhub-proxy-auth.inc` 由我们单独提供，只交给服务器管理员，放在上述绝对路径。它包含与 Worker 的 `MODHUB_PROXY_SECRET` 对应的代理凭据，覆盖访客自行提交的同名头；不要公开、提交仓库、放入客户端包或发送完整配置输出。该文件使用 `.inc` 后缀，只由公共配置引用，不会被 `*.conf` 单独加载。没有该私有文件时不要重载。

可信代理、真实 IP 限流及 Turnstile 公开域名校验已随 Worker 发布，`MODHUB_PROXY_SECRET` 已设置并回读确认。只有共享凭据与单个合法 IP 都通过校验，Worker 才使用代理声明的玩家地址和固定公开域名 `dol.alseece.top`；无效代理头回退到 Cloudflare 的直连身份。代理凭据不赋予协助、投稿或后台权限。仍待管理员应用私有 include 和下文的网站精确路径规则，再确认成功重载；不能以代码发布代替服务器和完整流程验收。Nginx 前若有其他代理，还需只对可信来源恢复真实 IP。

## 网站入口与当前发布资源

网站入口为 `https://dol.alseece.top/modhub/`，现有根目录继续使用 `/www/wwwroot/dol`。网站前缀仅回源 Pages 的当前公开页面和配套运行资源，避免绕过原敏感路径保护后公开未知文件。后续新增网站资源时同步更新该资源清单。

Worker 和 Pages 的变量 `proxy_pass` 均不附带 URI。`/modhub/` 先核验公开资源白名单，再通过 `rewrite ... break` 去掉该前缀并保留查询参数；上游变量赋值在 break 之前执行。不能给变量 proxy_pass 加尾 `/` 期待自动去掉前缀，也不能把 break 改为 last。网页路径使用必要的规范化跳转，协助 API 不增加跳转。[Nginx 代理说明](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_pass)

线上另发现 Pages 会将上游 `/index.html` 以 308 规范化到 `/?query`，原代理直接传回这一地址会使 `/modhub/index.html` 落到站点根目录。在服务器现有的 `modhub.conf` 中，将下面这一行加在 `location ^~ /modhub/` 附近，与它并列，不能放入其大括号内：

```nginx
location = /modhub/index.html { return 308 /modhub/$is_args$args; }
```

该精确规则直接返回 `/modhub/`，保留查询参数，不回源 Pages。不要调整其他 `proxy_redirect` 或业务规则。本地配置文本已补入该规则，线上仍待管理员应用并通过 `nginx -t` 后重载。

客户端的公开接口地址、下载链接和验证来源检查已完成代码适配；网页与后端已完成发布，Pages 生产版本为 `3fd45293`，原 Sites 公开入口版本 `24` 的发布状态为 `succeeded`。现有 Turnstile 已追加并回读确认 `dol.alseece.top`，原 Worker 域名、模式和 clearance 保持不变，未读取或替换 Turnstile secret。浏览器仍需访问官方验证资源；若该资源在玩家网络中无法加载，投稿和补充资料仍可能受阻。这些边界见上一层的反代交接说明。

## 测试与重载

现有站点只需完成空凭据行的替换、放置单独提供的 `modhub-proxy-auth.inc`，并在 `modhub.conf` 增加上述 `/modhub/index.html` 精确规则。保留已验证的 IPv4、DNS、系统 CA 和索引规则，不需要重新上传整套公共配置文件。

如果回源超时或被拒绝，先解决服务器的上游连接与对应安全规则，再加载配置；若返回 Cloudflare 1010，需要服务维护者根据安全事件核对浏览器签名拦截，不能以关闭证书验证解决。

在服务器使用宝塔的 Nginx 检查功能，或执行：

```bash
/www/server/nginx/sbin/nginx -t
```

只有检查成功后再执行平滑重载：

```bash
/www/server/nginx/sbin/nginx -s reload
```

上传文件不会自动证明运行中的 Nginx 已采用新配置；语法检查或重载失败时，旧配置可能继续提供服务。若仍返回 404，请回传 `nginx -t` 的结果，并在服务器检查以下过滤结果，确认扩展文件是否被读取；无需发送完整配置或密钥：

```bash
/www/server/nginx/sbin/nginx -T 2>/dev/null | grep -E '^# configuration file .*modhub[.]conf:|^[[:space:]]*location.*modhub'
```

`-T` 显示的是磁盘上的配置读取结果，仍须结合成功重载和实际 HTTP 响应判断运行状态。若 `-t` 失败，上面过滤命令的错误输出被隐藏，空结果不能证明文件未加载。

先验证 `/health` 返回 200 JSON，再验证索引、历史、说明、图片、身份字典、下载及 `/modhub/` 的配套资源。协助与投稿的 OPTIONS 应返回 204 及 CORS 头，不能返回 405。完整验收命令及后端分工见 [反代交接说明](../modhub-reverse-proxy-handoff.md)。

2026 年 10 月 13 日，IPv4 和系统 CA 修正后的公开接口复测通过，检查范围包括健康、索引、历史、说明、页面资源、下载包校验及协助和投稿预检。后续 Worker 已发布版本 `5e8f4ca4-0101-4afb-be86-bd1e0086d51a`，原绑定回读保留；网站发布及 Turnstile 域名也已完成核验。发布前后社区条目 38、投稿 53、事件 112 及其他相关表计数完全一致，外键检查为 0，无需数据库迁移。管理员私有 include 的放置、空凭据行替换、网站精确规则及重载仍待确认；上述 `/modhub/index.html` 跳转问题尚未在服务器修复。国内关闭 VPN 后的完整游戏、协助会话和验证码流程尚未验收。
