#!/usr/bin/env bash
set -euo pipefail

chart=deploy/helm/ipaffs-release-explorer
temp_dir=$(mktemp -d)
trap 'rm -rf "$temp_dir"' EXIT

values=(
  --values deployment/dev/values.yaml
  --set-string image.repository=example.azurecr.io/ipaffs/ipaffs-release-explorer
  --set-string image.digest=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
  --set-string workloadIdentity.clientId=11111111-1111-1111-1111-111111111111
  --set-string workloadIdentity.tenantId=22222222-2222-2222-2222-222222222222
  --set-string ado.organization=https://dev.azure.com/example-org
  --set-string ado.project=example-project
  --set ado.pipelines.dev=101
  --set ado.pipelines.createRelease=102
  --set ado.pipelines.release=103
  --set ado.pipelines.qa=104
)
helm lint "$chart" --strict "${values[@]}"
helm template ipaffs-release-explorer "$chart" --namespace ipaffs-release-explorer \
  "${values[@]}" > "$temp_dir/rendered.yaml"

# Required identity and immutable image configuration must fail closed.
if helm template invalid "$chart" >/dev/null 2>&1; then
  echo 'An unconfigured chart unexpectedly rendered successfully.' >&2
  exit 1
fi
if helm template invalid "$chart" "${values[@]}" --set-string image.digest=latest >/dev/null 2>&1; then
  echo 'An invalid image digest unexpectedly passed chart validation.' >&2
  exit 1
fi
echo 'Chart lint, rendering and required configuration checks passed.'
