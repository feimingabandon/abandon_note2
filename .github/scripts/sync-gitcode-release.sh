#!/usr/bin/env bash

set -euo pipefail

: "${GITCODE_TOKEN:?GITCODE_TOKEN is required}"
: "${GITCODE_OWNER:?GITCODE_OWNER is required}"
: "${GITCODE_REPO:?GITCODE_REPO is required}"
: "${RELEASE_TAG:?RELEASE_TAG is required}"
: "${RELEASE_NAME:?RELEASE_NAME is required}"
: "${RELEASE_BODY_FILE:?RELEASE_BODY_FILE is required}"
: "${RELEASE_ASSET_DIR:?RELEASE_ASSET_DIR is required}"

api_base="${GITCODE_API_BASE:-https://api.gitcode.com/api/v5}"
target_commitish="${TARGET_COMMITISH:-main}"
prerelease="${PRERELEASE:-false}"
release_status="latest"
if [[ "$prerelease" == "true" ]]; then
  release_status="pre"
fi
release_response="$(mktemp)"
upload_response="$(mktemp)"
release_payload="$(mktemp)"
trap 'rm -f "$release_response" "$upload_response" "$release_payload"' EXIT

upload_connect_timeout="${GITCODE_UPLOAD_CONNECT_TIMEOUT_SECONDS:-30}"
upload_max_time="${GITCODE_UPLOAD_MAX_TIME_SECONDS:-3600}"
upload_speed_time="${GITCODE_UPLOAD_LOW_SPEED_TIME_SECONDS:-300}"
upload_speed_limit="${GITCODE_UPLOAD_LOW_SPEED_LIMIT_BYTES:-16384}"

if [[ ! -f "$RELEASE_BODY_FILE" ]]; then
  echo "Release body file does not exist: $RELEASE_BODY_FILE" >&2
  exit 1
fi

if [[ ! -d "$RELEASE_ASSET_DIR" ]]; then
  echo "Release asset directory does not exist: $RELEASE_ASSET_DIR" >&2
  exit 1
fi

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
release_body="$(cat "$RELEASE_BODY_FILE")"
auth_headers=(
  --header "Accept: application/json"
  --header "Authorization: Bearer ${GITCODE_TOKEN}"
)

lookup_release() {
  curl --silent --show-error \
    --retry 3 \
    --retry-all-errors \
    --output "$release_response" \
    --write-out "%{http_code}" \
    "${auth_headers[@]}" \
    "${api_base}/repos/${GITCODE_OWNER}/${GITCODE_REPO}/releases/tags/${release_tag_encoded}"
}

lookup_status="$(lookup_release)"
if [[ "$lookup_status" == "200" ]]; then
  jq -n \
    --arg name "$RELEASE_NAME" \
    --arg body "$release_body" \
    --arg release_status "$release_status" \
    '{ name: $name, body: $body, release_status: $release_status }' \
    > "$release_payload"
  update_status="$(
    curl --silent --show-error \
      --retry 3 \
      --retry-all-errors \
      --output "$release_response" \
      --write-out "%{http_code}" \
      --request PATCH \
      "${auth_headers[@]}" \
      --header "Content-Type: application/json" \
      --data-binary "@${release_payload}" \
      "${api_base}/repos/${GITCODE_OWNER}/${GITCODE_REPO}/releases/${release_tag_encoded}"
  )"
  if [[ "$update_status" != "200" ]]; then
    echo "Updating GitCode Release failed with HTTP ${update_status}." >&2
    jq -r '.message // .error // "Unknown GitCode API error"' "$release_response" >&2 || true
    exit 1
  fi
  echo "Updated GitCode Release ${RELEASE_TAG}."
elif [[ "$lookup_status" == "400" || "$lookup_status" == "404" ]]; then
  jq -n \
    --arg tag_name "$RELEASE_TAG" \
    --arg name "$RELEASE_NAME" \
    --arg body "$release_body" \
    --arg target_commitish "$target_commitish" \
    --arg release_status "$release_status" \
    '{
      tag_name: $tag_name,
      name: $name,
      body: $body,
      target_commitish: $target_commitish,
      release_status: $release_status
    }' \
    > "$release_payload"
  access_token_encoded="$(jq -rn --arg value "$GITCODE_TOKEN" '$value | @uri')"
  create_status="$(
    curl --silent --show-error \
      --retry 3 \
      --retry-all-errors \
      --output "$release_response" \
      --write-out "%{http_code}" \
      --request POST \
      "${auth_headers[@]}" \
      --header "Content-Type: application/json" \
      --data-binary "@${release_payload}" \
      "${api_base}/repos/${GITCODE_OWNER}/${GITCODE_REPO}/releases?access_token=${access_token_encoded}"
  )"
  if [[ "$create_status" != "201" && "$create_status" != "200" ]]; then
    echo "Creating GitCode Release failed with HTTP ${create_status}." >&2
    jq -r '.message // .error // "Unknown GitCode API error"' "$release_response" >&2 || true
    exit 1
  fi
  echo "Created GitCode Release ${RELEASE_TAG}."
else
  echo "Looking up GitCode Release failed with HTTP ${lookup_status}." >&2
  jq -r '.message // .error // "Unknown GitCode API error"' "$release_response" >&2 || true
  exit 1
fi

lookup_status="$(lookup_release)"
if [[ "$lookup_status" != "200" ]]; then
  echo "Reading GitCode Release after upsert failed with HTTP ${lookup_status}." >&2
  exit 1
fi

for asset in "${assets[@]}"; do
  asset_name="$(basename "$asset")"
  asset_size="$(stat --format='%s' "$asset")"
  mapfile -t existing_ids < <(
    jq -r --arg name "$asset_name" '
      (.attach_files // .assets // .attachments // [])
      | .[]
      | select((.name // .file_name) == $name)
      | .id // empty
    ' "$release_response"
  )

  upload_url_status="$(
    curl --silent --show-error \
      --retry 3 \
      --retry-all-errors \
      --output "$upload_response" \
      --write-out "%{http_code}" \
      --get \
      "${auth_headers[@]}" \
      --data-urlencode "access_token=${GITCODE_TOKEN}" \
      --data-urlencode "file_name=${asset_name}" \
      "${api_base}/repos/${GITCODE_OWNER}/${GITCODE_REPO}/releases/${release_tag_encoded}/upload_url"
  )"
  if [[ "$upload_url_status" != "200" ]]; then
    echo "Getting the GitCode upload URL for ${asset_name} failed with HTTP ${upload_url_status}." >&2
    jq -r '.message // .error // "Unknown GitCode API error"' "$upload_response" >&2 || true
    exit 1
  fi

  upload_url="$(jq -r '.url // empty' "$upload_response")"
  if [[ -z "$upload_url" ]]; then
    echo "GitCode did not return an upload URL for ${asset_name}." >&2
    exit 1
  fi

  upload_headers=()
  while IFS=$'\t' read -r header_name header_value; do
    upload_headers+=(--header "${header_name}: ${header_value}")
  done < <(
    jq -r '(.headers // {}) | to_entries[] | [.key, (.value | tostring)] | @tsv' \
      "$upload_response"
  )

  echo "Uploading ${asset_name} (${asset_size} bytes) to GitCode."
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
      --output /dev/null \
      --write-out "%{http_code}" \
      --request PUT \
      "${upload_headers[@]}" \
      --upload-file "$asset" \
      "$upload_url"
  )"
  if [[ "$upload_status" != "200" && "$upload_status" != "201" && "$upload_status" != "204" ]]; then
    echo "Uploading ${asset_name} to GitCode failed with HTTP ${upload_status}." >&2
    exit 1
  fi

  uploaded_id=""
  current_ids=()
  for attempt in 1 2 3 4 5; do
    lookup_status="$(lookup_release)"
    if [[ "$lookup_status" == "200" ]]; then
      mapfile -t current_ids < <(
        jq -r --arg name "$asset_name" '
          (.attach_files // .assets // .attachments // [])
          | .[]
          | select((.name // .file_name) == $name)
          | .id // empty
        ' "$release_response"
      )
      for current_id in "${current_ids[@]}"; do
        if [[ ! " ${existing_ids[*]} " =~ [[:space:]]${current_id}[[:space:]] ]]; then
          uploaded_id="$current_id"
          break
        fi
      done
      if [[ -n "$uploaded_id" || "${#current_ids[@]}" -gt 0 ]]; then
        break
      fi
    fi
    sleep 2
  done

  if [[ "$lookup_status" != "200" || "${#current_ids[@]}" -eq 0 ]]; then
    echo "GitCode accepted ${asset_name}, but the attachment did not appear in the Release." >&2
    exit 1
  fi

  if [[ -n "$uploaded_id" ]]; then
    for attachment_id in "${existing_ids[@]}"; do
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
          "${auth_headers[@]}" \
          --data-urlencode "access_token=${GITCODE_TOKEN}" \
          "${api_base}/repos/${GITCODE_OWNER}/${GITCODE_REPO}/releases/${release_tag_encoded}/attach_files/${attachment_id}"
      )"
      if [[ "$delete_status" != "204" && "$delete_status" != "200" ]]; then
        echo "Deleting superseded GitCode attachment ${asset_name} failed with HTTP ${delete_status}." >&2
        exit 1
      fi
    done
  fi

  echo "Uploaded ${asset_name} to GitCode."
done

echo "Synchronized ${#assets[@]} release assets to GitCode Release ${RELEASE_TAG}."
