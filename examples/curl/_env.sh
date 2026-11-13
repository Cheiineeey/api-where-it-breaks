# 被下面几个脚本 source。按 guide §1.1.1 选请求头：
# 直连官方用 x-api-key，多数中转站用 Bearer。
set -euo pipefail
: "${API_BASE:=https://api.anthropic.com}"
: "${API_KEY:?缺少 API_KEY}"
: "${API_VERSION:=2026-10-21}"
if [ -z "${AUTH_STYLE:-}" ]; then
  case "$API_BASE" in *api.anthropic.com*) AUTH_STYLE=x-api-key ;; *) AUTH_STYLE=bearer ;; esac
fi
if [ "$AUTH_STYLE" = bearer ]; then AUTH_HEADER="Authorization: Bearer $API_KEY"; else AUTH_HEADER="x-api-key: $API_KEY"; fi
