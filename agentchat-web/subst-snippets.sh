#!/bin/sh
# 把 /etc/nginx/templates-snippets/*.template envsubst 到 /etc/nginx/snippets/
# （官方 envsubst 脚本只处理 templates/ → conf.d/，会误入 http 顶层；
#   共享 server 片段需要放 snippets/ 供 server 块 include）
# 只替换已定义的环境变量，保留 $uri 等 nginx 内置变量（与官方脚本同法）。
set -e
mkdir -p /etc/nginx/snippets
defined_envs=$(printf '${%s} ' $(awk 'END { for (name in ENVIRON) print (name ~ /^[A-Za-z_][A-Za-z0-9_]*$/) ? name : "" }' < /dev/null))
for tmpl in /etc/nginx/templates-snippets/*.template; do
  [ -e "$tmpl" ] || continue
  out="/etc/nginx/snippets/$(basename "$tmpl" .template)"
  envsubst "$defined_envs" < "$tmpl" > "$out"
  echo "subst-snippets: $tmpl -> $out"
done
