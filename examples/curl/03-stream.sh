#!/usr/bin/env bash
# 流式：-N 关掉 curl 的缓冲，才看得出是不是真的在逐字来（guide §3）
. "$(dirname "$0")/_env.sh"
: "${MODEL:?缺少 MODEL}"
curl -sS -N "$API_BASE/v1/messages" \
  -H "$AUTH_HEADER" \
  -H "anthropic-version: $API_VERSION" \
  -H "content-type: application/json" \
  --max-time 300 \
  -d "{
    \"model\": \"$MODEL\",
    \"max_tokens\": 64000,
    \"stream\": true,
    \"messages\": [{\"role\": \"user\", \"content\": \"数到五，每个数一行\"}]
  }"
