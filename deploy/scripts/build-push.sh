#!/usr/bin/env bash
set -euo pipefail

# ADO leaves an unresolved $(variable) literal when a variable is absent.
# shellcheck disable=SC2016
for name in ACR_NAME IMAGE_REPOSITORY BUILD_ID SOURCE_REVISION ARTIFACT_DIR DOCKER_CONFIG; do
  if [[ -z "${!name:-}" || "${!name}" == *'$('* ]]; then
    echo "Required pipeline variable ${name} is missing." >&2
    exit 1
  fi
done
[[ "$BUILD_ID" =~ ^[0-9]+$ ]] || { echo 'BUILD_ID must be numeric.' >&2; exit 1; }

mkdir -p "$ARTIFACT_DIR" "$DOCKER_CONFIG"
chmod 700 "$DOCKER_CONFIG"
# Keep registry credentials in this run's temporary Docker config.
trap 'rm -f "$DOCKER_CONFIG/config.json"' EXIT

registry=$(az acr show --name "$ACR_NAME" --query loginServer --output tsv)
image_tag="build-${BUILD_ID}"
image="${registry}/${IMAGE_REPOSITORY}:${image_tag}"

az acr login --name "$ACR_NAME" --output none
docker build --pull --platform linux/amd64 \
  --label "org.opencontainers.image.revision=${SOURCE_REVISION}" \
  --label "org.opencontainers.image.version=${image_tag}" \
  --tag "$image" --file Dockerfile .
docker push "$image"

digest=$(az acr repository show --name "$ACR_NAME" --image "${IMAGE_REPOSITORY}:${image_tag}" --query digest --output tsv)
[[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo 'ACR did not return an image digest.' >&2; exit 1; }
jq -n --arg repository "${registry}/${IMAGE_REPOSITORY}" --arg digest "$digest" \
  --arg tag "$image_tag" --arg revision "$SOURCE_REVISION" --arg buildId "$BUILD_ID" \
  '{repository:$repository,digest:$digest,tag:$tag,revision:$revision,buildId:$buildId}' \
  > "$ARTIFACT_DIR/image.json"

helm package deploy/helm/ipaffs-release-explorer \
  --version "0.1.0-build.${BUILD_ID}" --app-version "$image_tag" --destination "$ARTIFACT_DIR"
cp deployment/dev/values.yaml "$ARTIFACT_DIR/dev-values.yaml"
echo "Published ${image} and recorded its digest for deployment."
