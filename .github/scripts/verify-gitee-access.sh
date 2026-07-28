#!/usr/bin/env bash

set -euo pipefail

: "${GITEE_TOKEN:?GITEE_TOKEN is required}"
: "${GITEE_OWNER:?GITEE_OWNER is required}"
: "${GITEE_REPO:?GITEE_REPO is required}"

api_base="${GITEE_API_BASE:-https://gitee.com/api/v5}"
response_file="$(mktemp)"
trap 'rm -f "$response_file"' EXIT

status_code="$(
  curl --silent --show-error \
    --retry 3 \
    --retry-all-errors \
    --output "$response_file" \
    --write-out "%{http_code}" \
    --get \
    --data-urlencode "access_token=${GITEE_TOKEN}" \
    "${api_base}/repos/${GITEE_OWNER}/${GITEE_REPO}"
)"

if [[ "$status_code" != "200" ]]; then
  echo "Gitee repository access failed with HTTP ${status_code}." >&2
  jq -r '.message // .error // "Unknown Gitee API error"' "$response_file" >&2 || true
  exit 1
fi

full_name="$(jq -r '.full_name // empty' "$response_file")"
if [[ "$full_name" != "${GITEE_OWNER}/${GITEE_REPO}" ]]; then
  echo "Gitee API returned an unexpected repository: ${full_name:-missing}." >&2
  exit 1
fi

echo "Verified Gitee access to ${full_name}."
