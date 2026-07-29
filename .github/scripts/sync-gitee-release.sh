#!/usr/bin/env bash

set -euo pipefail

: "${GITEE_TOKEN:?GITEE_TOKEN is required}"
: "${GITEE_OWNER:?GITEE_OWNER is required}"
: "${GITEE_REPO:?GITEE_REPO is required}"
: "${RELEASE_TAG:?RELEASE_TAG is required}"
: "${RELEASE_NAME:?RELEASE_NAME is required}"
: "${RELEASE_BODY_FILE:?RELEASE_BODY_FILE is required}"
: "${RELEASE_ASSET_DIR:?RELEASE_ASSET_DIR is required}"

api_base="${GITEE_API_BASE:-https://gitee.com/api/v5}"
target_commitish="${TARGET_COMMITISH:-main}"
prerelease="${PRERELEASE:-false}"
release_response="$(mktemp)"
attachments_response="$(mktemp)"
upload_response="$(mktemp)"
trap 'rm -f "$release_response" "$attachments_response" "$upload_response"' EXIT

upload_connect_timeout="${GITEE_UPLOAD_CONNECT_TIMEOUT_SECONDS:-30}"
upload_max_time="${GITEE_UPLOAD_MAX_TIME_SECONDS:-3600}"
upload_speed_time="${GITEE_UPLOAD_LOW_SPEED_TIME_SECONDS:-300}"
upload_speed_limit="${GITEE_UPLOAD_LOW_SPEED_LIMIT_BYTES:-16384}"

if [[ ! -f "$RELEASE_BODY_FILE" ]]; then
  echo "Release body file does not exist: $RELEASE_BODY_FILE" >&2
  exit 1
fi

if [[ ! -d "$RELEASE_ASSET_DIR" ]]; then
  echo "Release asset directory does not exist: $RELEASE_ASSET_DIR" >&2
  exit 1
fi

# 小文件优先：先验证附件 API 确实可写，再进入 200MB 以上安装包上传。
mapfile -d '' assets < <(
  find "$RELEASE_ASSET_DIR" -maxdepth 1 -type f -printf '%s\t%p\0' |
    sort -z -n |
    cut -z -f2-
)
if [[ "${#assets[@]}" -eq 0 ]]; then
  echo "No GitHub Release assets were downloaded." >&2
  exit 1
fi

release_tag_encoded="$(jq -rn --arg value "$RELEASE_TAG" '$value | @uri')"
lookup_status="$(
  curl --silent --show-error \
    --retry 3 \
    --retry-all-errors \
    --output "$release_response" \
    --write-out "%{http_code}" \
    --get \
    --data-urlencode "access_token=${GITEE_TOKEN}" \
    "${api_base}/repos/${GITEE_OWNER}/${GITEE_REPO}/releases/tags/${release_tag_encoded}"
)"

release_body="$(cat "$RELEASE_BODY_FILE")"

release_id=""

if [[ "$lookup_status" == "200" ]]; then
  release_id="$(jq -r '.id // empty' "$release_response")"
  if [[ -z "$release_id" ]]; then
    if jq -e 'type == "null"' "$release_response" >/dev/null; then
      # Gitee returns HTTP 200 with literal JSON null when the tag exists but
      # no Release has been created for it yet.
      echo "Gitee has no Release for ${RELEASE_TAG}; creating one."
    else
      echo "Gitee returned HTTP 200 but not a Release object for ${RELEASE_TAG}." >&2
      jq -c . "$release_response" >&2 || true
      exit 1
    fi
  else
    update_status="$(
      curl --silent --show-error \
        --retry 3 \
        --retry-all-errors \
        --output "$release_response" \
        --write-out "%{http_code}" \
        --request PATCH \
        --form-string "access_token=${GITEE_TOKEN}" \
        --form-string "tag_name=${RELEASE_TAG}" \
        --form-string "name=${RELEASE_NAME}" \
        --form-string "body=${release_body}" \
        --form-string "prerelease=${prerelease}" \
        "${api_base}/repos/${GITEE_OWNER}/${GITEE_REPO}/releases/${release_id}"
    )"
    if [[ "$update_status" != "200" ]]; then
      echo "Updating Gitee Release failed with HTTP ${update_status}." >&2
      jq -r '.message // .error // "Unknown Gitee API error"' "$release_response" >&2 || true
      exit 1
    fi
    echo "Updated Gitee Release ${RELEASE_TAG}."
  fi
elif [[ "$lookup_status" != "404" ]]; then
  echo "Looking up Gitee Release failed with HTTP ${lookup_status}." >&2
  jq -r '.message // .error // "Unknown Gitee API error"' "$release_response" >&2 || true
  exit 1
fi

if [[ -z "$release_id" ]]; then
  create_status="$(
    curl --silent --show-error \
      --retry 3 \
      --retry-all-errors \
      --output "$release_response" \
      --write-out "%{http_code}" \
      --request POST \
      --form-string "access_token=${GITEE_TOKEN}" \
      --form-string "tag_name=${RELEASE_TAG}" \
      --form-string "name=${RELEASE_NAME}" \
      --form-string "body=${release_body}" \
      --form-string "prerelease=${prerelease}" \
      --form-string "target_commitish=${target_commitish}" \
      "${api_base}/repos/${GITEE_OWNER}/${GITEE_REPO}/releases"
  )"
  if [[ "$create_status" != "201" && "$create_status" != "200" ]]; then
    echo "Creating Gitee Release failed with HTTP ${create_status}." >&2
    jq -r '.message // .error // "Unknown Gitee API error"' "$release_response" >&2 || true
    exit 1
  fi
  release_id="$(jq -r '.id // empty' "$release_response")"
  if [[ -z "$release_id" ]]; then
    echo "Created Gitee Release did not include an id." >&2
    exit 1
  fi
  echo "Created Gitee Release ${RELEASE_TAG}."
fi

attachments_status="$(
  curl --silent --show-error \
    --retry 3 \
    --retry-all-errors \
    --output "$attachments_response" \
    --write-out "%{http_code}" \
    --get \
    --data-urlencode "access_token=${GITEE_TOKEN}" \
    --data-urlencode "page=1" \
    --data-urlencode "per_page=100" \
    "${api_base}/repos/${GITEE_OWNER}/${GITEE_REPO}/releases/${release_id}/attach_files"
)"

if [[ "$attachments_status" != "200" ]]; then
  echo "Listing Gitee Release attachments failed with HTTP ${attachments_status}." >&2
  jq -r '.message // .error // "Unknown Gitee API error"' "$attachments_response" >&2 || true
  exit 1
fi

for asset in "${assets[@]}"; do
  asset_name="$(basename "$asset")"
  asset_size="$(stat --format='%s' "$asset")"

  mapfile -t existing_ids < <(
    jq -r --arg name "$asset_name" '.[] | select(.name == $name) | .id' "$attachments_response"
  )

  echo "Uploading ${asset_name} (${asset_size} bytes) to Gitee."
  echo "A transfer below ${upload_speed_limit} bytes/s for ${upload_speed_time}s will fail instead of hanging indefinitely."

  upload_status="$(
    curl --show-error \
      --progress-bar \
      --http1.1 \
      --connect-timeout "$upload_connect_timeout" \
      --max-time "$upload_max_time" \
      --speed-time "$upload_speed_time" \
      --speed-limit "$upload_speed_limit" \
      --retry 1 \
      --retry-delay 15 \
      --retry-connrefused \
      --output "$upload_response" \
      --write-out "%{http_code}" \
      --request POST \
      --form-string "access_token=${GITEE_TOKEN}" \
      --form "file=@${asset}" \
      "${api_base}/repos/${GITEE_OWNER}/${GITEE_REPO}/releases/${release_id}/attach_files"
  )"
  if [[ "$upload_status" != "201" && "$upload_status" != "200" ]]; then
    echo "Uploading ${asset_name} to Gitee failed with HTTP ${upload_status}." >&2
    jq -r '.message // .error // "Unknown Gitee API error"' "$upload_response" >&2 || true
    exit 1
  fi

  uploaded_id="$(jq -r '.id // empty' "$upload_response")"
  if [[ -z "$uploaded_id" ]]; then
    echo "Gitee accepted ${asset_name} but did not return an attachment id." >&2
    exit 1
  fi

  # 新文件完整上传后才删除旧同名附件；网络中断不会先破坏已发布的下载入口。
  for attachment_id in "${existing_ids[@]}"; do
    if [[ "$attachment_id" == "$uploaded_id" ]]; then
      continue
    fi
    delete_status="$(
      curl --silent --show-error \
        --connect-timeout 30 \
        --max-time 120 \
        --retry 2 \
        --retry-all-errors \
        --output /dev/null \
        --write-out "%{http_code}" \
        --request DELETE \
        --get \
        --data-urlencode "access_token=${GITEE_TOKEN}" \
        "${api_base}/repos/${GITEE_OWNER}/${GITEE_REPO}/releases/${release_id}/attach_files/${attachment_id}"
    )"
    if [[ "$delete_status" != "204" && "$delete_status" != "200" ]]; then
      echo "Deleting superseded Gitee attachment ${asset_name} failed with HTTP ${delete_status}." >&2
      exit 1
    fi
  done

  echo "Uploaded ${asset_name} to Gitee."
done

echo "Synchronized ${#assets[@]} release assets to Gitee Release ${RELEASE_TAG}."
