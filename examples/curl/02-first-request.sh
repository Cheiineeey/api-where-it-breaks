#!/usr/bin/env bash
# 最小非流式请求（guide §1.3）。max_tokens 别给太小，思考也算在里面。
. "$(dirname "$0")/_env.sh"
: "${MODEL:?缺少 MODEL，先跑 01-models.sh}"
curl -sS "$API_BASE/v1/messages" \
  -H "$AUTH_HEADER" \
  -H "anthropic-version: $API_VERSION" \
  -H "content-type: application/json" \
  --max-time 120 \
  -d "{
    \"model\": \"$MODEL\",
    \"max_tokens\": 16000,
    \"messages\": [{\"role\": \"user\", \"content\": \"只回复：连接成功\"}]
  }"
echo
