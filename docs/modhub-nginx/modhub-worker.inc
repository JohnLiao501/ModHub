# ModHub Worker 代理公共配置，只能由业务 location 引用。
# CA 使用目标 Alibaba Cloud Linux 3 的系统证书包，部署前须验证回源。
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

proxy_set_header X-ModHub-Proxy-Client-IP $remote_addr;
# 私有凭据文件由维护者单独提供，只交给服务器管理员，不进入仓库。
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
