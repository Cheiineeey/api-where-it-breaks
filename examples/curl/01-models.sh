#!/usr/bin/env bash
# 先列模型：中转站的模型标签常常不是官方名（guide §1.2）
. "$(dirname "$0")/_env.sh"
curl -sS "$API_BASE/v1/models" \
  -H "$AUTH_HEADER" \
  -H "anthropic-version: $API_VERSION"
echo
