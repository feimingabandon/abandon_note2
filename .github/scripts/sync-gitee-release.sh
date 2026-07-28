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
trap 'rm -f "$release_response" "$attachments_response"' EXIT

if [[ ! -f "$RELEASE_BODY_FILE" ]]; then
  echo "Release body file does not exist: $RELEASE_BODY_FILE" >&2
  exit 1
fi

if [[ ! -d "$RELEASE_ASSET_DIR" ]]; then
  echo "Release asset directory does not exist: $RELEASE_ASSET_DIR" >&2
  exit 1
fi

mapfile -d '' assets < <(find "$RELEASE_ASSET_DIR" -maxdepth 1 -type f -print0 | sort -z)
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

if [[ "$lookup_status" == "200" ]]; then
  release_id="$(jq -r '.id // empty' "$release_response")"
  if [[ -z "$release_id" ]]; then
    echo "Existing Gitee Release did not include an id." >&2
    exit 1
  fi

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
elif [[ "$lookup_status" == "404" ]]; then
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
else
  echo "Looking up Gitee Release failed with HTTP ${lookup_status}." >&2
  jq -r '.message // .error // "Unknown Gitee API error"' "$release_response" >&2 || true
  exit 1
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

  mapfile -t existing_ids < <(
    jq -r --arg name "$asset_name" '.[] | select(.name == $name) | .id' "$attachments_response"
  )

  for attachment_id in "${existing_ids[@]}"; do
    delete_status="$(
      curl --silent --show-error \
        --retry 3 \
        --retry-all-errors \
        --output /dev/null \
        --write-out "%{http_code}" \
        --request DELETE \
        --get \
        --data-urlencode "access_token=${GITEE_TOKEN}" \
        "${api_base}/repos/${GITEE_OWNER}/${GITEE_REPO}/releases/${release_id}/attach_files/${attachment_id}"
    )"
    if [[ "$delete_status" != "204" && "$delete_status" != "200" ]]; then
      echo "Deleting existing Gitee attachment ${asset_name} failed with HTTP ${delete_status}." >&2
      exit 1
    fi
  done

  upload_status="$(
    curl --silent --show-error \
      --retry 3 \
      --retry-all-errors \
      --output "$attachments_response" \
      --write-out "%{http_code}" \
      --request POST \
      --form-string "access_token=${GITEE_TOKEN}" \
      --form "file=@${asset}" \
      "${api_base}/repos/${GITEE_OWNER}/${GITEE_REPO}/releases/${release_id}/attach_files"
  )"
  if [[ "$upload_status" != "201" && "$upload_status" != "200" ]]; then
    echo "Uploading ${asset_name} to Gitee failed with HTTP ${upload_status}." >&2
    jq -r '.message // .error // "Unknown Gitee API error"' "$attachments_response" >&2 || true
    exit 1
  fi

  echo "Uploaded ${asset_name} to Gitee."
done

echo "Synchronized ${#assets[@]} release assets to Gitee Release ${RELEASE_TAG}."
