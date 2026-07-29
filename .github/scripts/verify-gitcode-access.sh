#!/usr/bin/env bash

set -euo pipefail

: "${GITCODE_TOKEN:?GITCODE_TOKEN is required}"
: "${GITCODE_OWNER:?GITCODE_OWNER is required}"
: "${GITCODE_REPO:?GITCODE_REPO is required}"

api_base="${GITCODE_API_BASE:-https://api.gitcode.com/api/v5}"
response_file="$(mktemp)"
trap 'rm -f "$response_file"' EXIT

status_code="$(
  curl --silent --show-error \
    --retry 3 \
    --retry-all-errors \
    --output "$response_file" \
    --write-out "%{http_code}" \
    --header "Accept: application/json" \
    --header "Authorization: Bearer ${GITCODE_TOKEN}" \
    "${api_base}/repos/${GITCODE_OWNER}/${GITCODE_REPO}"
)"

if [[ "$status_code" != "200" ]]; then
  echo "GitCode repository access failed with HTTP ${status_code}." >&2
  jq -r '.message // .error // "Unknown GitCode API error"' "$response_file" >&2 || true
  exit 1
fi

full_name="$(jq -r '.full_name // empty' "$response_file")"
if [[ "$full_name" != "${GITCODE_OWNER}/${GITCODE_REPO}" ]]; then
  echo "GitCode API returned an unexpected repository: ${full_name:-missing}." >&2
  exit 1
fi

echo "Verified GitCode access to ${full_name}."
