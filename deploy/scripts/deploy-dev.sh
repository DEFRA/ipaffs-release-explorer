#!/usr/bin/env bash
set -euo pipefail

# shellcheck disable=SC2016
for name in AKS_NAME AKS_RESOURCE_GROUP ACR_NAME NAMESPACE IDENTITY_RESOURCE_ID IDENTITY_CLIENT_ID IDENTITY_TENANT_ID \
  ADO_ORGANIZATION ADO_PROJECT ADO_DEV_PIPELINE_ID ADO_CREATE_RELEASE_PIPELINE_ID ADO_RELEASE_PIPELINE_ID ADO_QA_PIPELINE_ID \
  INGRESS_HOST ARTIFACT_DIR DEPLOY_TEMP_DIR; do
  if [[ -z "${!name:-}" || "${!name}" == *'$('* ]]; then
    echo "Required pipeline variable ${name} is missing. Complete DEV configuration before deploying." >&2
    exit 1
  fi
done
for name in ADO_DEV_PIPELINE_ID ADO_CREATE_RELEASE_PIPELINE_ID ADO_RELEASE_PIPELINE_ID ADO_QA_PIPELINE_ID; do
  if [[ ! "${!name}" =~ ^[1-9][0-9]{0,8}$ ]] || (( ${!name} > 100000000 )); then
    echo "${name} must be a positive pipeline ID no greater than 100000000." >&2
    exit 1
  fi
done
if [[ ! "$ADO_ORGANIZATION" =~ ^https://dev\.azure\.com/[A-Za-z0-9_-]+$ ]]; then
  echo 'ADO_ORGANIZATION must be an HTTPS dev.azure.com organisation URL.' >&2
  exit 1
fi
if [[ ${#INGRESS_HOST} -gt 253 || "$INGRESS_HOST" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ || ! "$INGRESS_HOST" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]]; then
  echo 'INGRESS_HOST must be a lowercase DNS hostname without a scheme, port or path.' >&2
  exit 1
fi
if [[ ! "$NAMESPACE" =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ || ${#NAMESPACE} -gt 63 ]]; then
  echo 'NAMESPACE must be a valid Kubernetes namespace.' >&2
  exit 1
fi
case "$NAMESPACE" in
  dev|tst|pre|prd|default|kube-*) echo 'Use a dedicated namespace for the release explorer.' >&2; exit 1 ;;
esac

mkdir -p "$DEPLOY_TEMP_DIR/bin"
chmod 700 "$DEPLOY_TEMP_DIR"
export KUBECONFIG="$DEPLOY_TEMP_DIR/kubeconfig"
export PATH="$DEPLOY_TEMP_DIR/bin:$PATH"
trap 'rm -f "$KUBECONFIG" "$DEPLOY_TEMP_DIR/runtime-values.json" "$DEPLOY_TEMP_DIR/ingress-health.json"' EXIT

az aks show --name "$AKS_NAME" --resource-group "$AKS_RESOURCE_GROUP" --output json > "$DEPLOY_TEMP_DIR/aks.json"
if ! jq -e '.oidcIssuerProfile.enabled == true and .securityProfile.workloadIdentity.enabled == true' "$DEPLOY_TEMP_DIR/aks.json" >/dev/null; then
  echo 'DEV AKS must already have OIDC and Workload Identity enabled.' >&2
  exit 1
fi
issuer=$(jq -r '.oidcIssuerProfile.issuerUrl' "$DEPLOY_TEMP_DIR/aks.json")
cluster_version=$(jq -r '.currentKubernetesVersion // .kubernetesVersion' "$DEPLOY_TEMP_DIR/aks.json")

az identity show --ids "$IDENTITY_RESOURCE_ID" --output json > "$DEPLOY_TEMP_DIR/identity.json"
if ! jq -e --arg client "$IDENTITY_CLIENT_ID" --arg tenant "$IDENTITY_TENANT_ID" \
  '(.clientId | ascii_downcase) == ($client | ascii_downcase) and (.tenantId | ascii_downcase) == ($tenant | ascii_downcase)' \
  "$DEPLOY_TEMP_DIR/identity.json" >/dev/null; then
  echo 'The configured identity resource, client ID and tenant ID do not match.' >&2
  exit 1
fi
identity_name=$(jq -r '.name' "$DEPLOY_TEMP_DIR/identity.json")
identity_group=$(jq -r '.resourceGroup' "$DEPLOY_TEMP_DIR/identity.json")
identity_subscription=$(printf '%s' "$IDENTITY_RESOURCE_ID" | cut -d/ -f3)
az identity federated-credential list --identity-name "$identity_name" --resource-group "$identity_group" \
  --subscription "$identity_subscription" --output json > "$DEPLOY_TEMP_DIR/federation.json"
if ! jq -e --arg issuer "$issuer" --arg subject "system:serviceaccount:${NAMESPACE}:ipaffs-release-explorer" \
  'any(.[]; .issuer == $issuer and .subject == $subject and (.audiences | index("api://AzureADTokenExchange") != null))' \
  "$DEPLOY_TEMP_DIR/federation.json" >/dev/null; then
  echo 'The managed identity lacks a federated credential for this DEV cluster, namespace and service account.' >&2
  exit 1
fi

repository=$(jq -er '.repository' "$ARTIFACT_DIR/image.json")
digest=$(jq -er '.digest' "$ARTIFACT_DIR/image.json")
az acr show --name "$ACR_NAME" --output json > "$DEPLOY_TEMP_DIR/acr.json"
registry=$(jq -r '.loginServer' "$DEPLOY_TEMP_DIR/acr.json")
if [[ "$repository" != "${registry}/ipaffs/ipaffs-release-explorer" || ! "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo 'The deployment artifact does not identify a valid release explorer image in DEV ACR.' >&2
  exit 1
fi

# The kubelet pulls images; the application's managed identity only reads ADO.
# Existing IPAFFS ACR access can be inherited through an Entra group. This is a
# read-only diagnostic: missing Graph visibility must not be mistaken for no access.
kubelet_id=$(jq -r '.identityProfile.kubeletidentity.objectId // empty' "$DEPLOY_TEMP_DIR/aks.json")
acr_id=$(jq -r '.id' "$DEPLOY_TEMP_DIR/acr.json")
if [[ -n "$kubelet_id" ]] && az role assignment list --assignee "$kubelet_id" --scope "$acr_id" \
  --include-inherited --include-groups --fill-principal-name false --output json > "$DEPLOY_TEMP_DIR/acr-roles.json"; then
  if jq -e 'any(.[]; .roleDefinitionName == "AcrPull" or .roleDefinitionName == "AcrPush" or .roleDefinitionName == "Container Registry Repository Reader")' \
    "$DEPLOY_TEMP_DIR/acr-roles.json" >/dev/null; then
    echo 'An existing ACR pull role is visible for the DEV kubelet identity.'
  else
    echo '##vso[task.logissue type=warning]ACR pull access could not be established from visible role assignments; the rollout will verify the image can be pulled.'
  fi
else
  echo '##vso[task.logissue type=warning]Could not inspect kubelet ACR role assignments. Verify existing ACR pull access if the rollout reports ImagePullBackOff.'
fi

az aks install-cli --client-version "v${cluster_version}" --install-location "$DEPLOY_TEMP_DIR/bin/kubectl" \
  --kubelogin-version v0.2.18 --kubelogin-install-location "$DEPLOY_TEMP_DIR/bin/kubelogin"
az aks get-credentials --name "$AKS_NAME" --resource-group "$AKS_RESOURCE_GROUP" --file "$KUBECONFIG" --overwrite-existing
kubelogin convert-kubeconfig -l azurecli

charts=("$ARTIFACT_DIR"/ipaffs-release-explorer-*.tgz)
[[ ${#charts[@]} == 1 && -f "${charts[0]}" ]] || { echo 'Expected exactly one packaged chart.' >&2; exit 1; }
# JSON avoids quoting problems for project names and keeps environment configuration
# out of the public chart and the build artifact. These are configuration IDs, not credentials.
jq -n --arg repository "$repository" --arg digest "$digest" \
  --arg clientId "$IDENTITY_CLIENT_ID" --arg tenantId "$IDENTITY_TENANT_ID" \
  --arg organization "$ADO_ORGANIZATION" --arg project "$ADO_PROJECT" \
  --arg ingressHost "$INGRESS_HOST" \
  --argjson dev "$ADO_DEV_PIPELINE_ID" --argjson createRelease "$ADO_CREATE_RELEASE_PIPELINE_ID" \
  --argjson release "$ADO_RELEASE_PIPELINE_ID" --argjson qa "$ADO_QA_PIPELINE_ID" \
  '{image:{repository:$repository,digest:$digest}, workloadIdentity:{clientId:$clientId,tenantId:$tenantId},
    ingress:{host:$ingressHost},
    ado:{organization:$organization,project:$project,pipelines:{dev:$dev,createRelease:$createRelease,release:$release,qa:$qa}}}' \
  > "$DEPLOY_TEMP_DIR/runtime-values.json"
chmod 600 "$DEPLOY_TEMP_DIR/runtime-values.json"
helm upgrade --install ipaffs-release-explorer "${charts[0]}" \
  --namespace "$NAMESPACE" --create-namespace \
  --values "$ARTIFACT_DIR/dev-values.yaml" \
  --values "$DEPLOY_TEMP_DIR/runtime-values.json" \
  --atomic --wait --timeout 10m --history-max 10

# Verify DNS, certificate trust/hostname, ingress routing and the app Host allowlist.
# Use normal TLS validation; a mismatched controller certificate must fail the run.
curl --fail --silent --show-error --connect-timeout 10 --max-time 15 \
  --retry 6 --retry-delay 5 --retry-all-errors \
  --output "$DEPLOY_TEMP_DIR/ingress-health.json" "https://${INGRESS_HOST}/healthz"
if ! jq -e '.status == "ok" and .readOnly == true' "$DEPLOY_TEMP_DIR/ingress-health.json" >/dev/null; then
  echo 'Ingress health check did not reach the release explorer.' >&2
  exit 1
fi
echo 'Ingress HTTPS check passed.'

# A ready process is not enough: verify that the pod can read ADO using its identity.
# Emit only status/counts, never tokens, upstream responses or pipeline log contents.
# shellcheck disable=SC2016
kubectl --namespace "$NAMESPACE" exec deployment/ipaffs-release-explorer -- node --input-type=module -e '
  // A newly created federation can take time to become usable at the token endpoint.
  let response, dashboard;
  for (let attempt = 0; attempt < 6; attempt++) {
    response = await fetch("http://127.0.0.1:4317/api/dashboard", {signal: AbortSignal.timeout(240000)});
    dashboard = await response.json();
    if (dashboard.error?.code !== "workload_identity_unavailable" || attempt === 5) break;
    console.log("Waiting briefly for workload identity token exchange to become available.");
    await new Promise(resolve => setTimeout(resolve, 10000));
  }
  if (!response.ok || dashboard.mode !== "live" || dashboard.error) {
    console.error("ADO read smoke check failed. Verify the managed identity has access to the ADO project and pipelines.");
    process.exit(1);
  }
  const pipelines = dashboard.limits?.pipelines || [];
  if (!["dev", "create", "release", "qa"].every(kind => pipelines.some(p => p.kind === kind && p.count > 0))) {
    console.error("ADO read smoke check failed: expected pipeline history is missing. Check pipeline visibility for the managed identity.");
    process.exit(1);
  }
  const warnings = dashboard.warnings || [];
  if (warnings.some(w => ["run_state_unavailable", "environments_unavailable", "environment_history_unavailable"].includes(w.code))) {
    console.error("ADO read smoke check failed: current run states or Environment history could not be verified. The identity must be able to read run pages, Environments and the Build API.");
    process.exit(1);
  }
  if (warnings.length) console.log(`History coverage has ${warnings.length} warning(s); inspect coverage in the dashboard.`);
  console.log("ADO read smoke check passed; dashboard is live.");
'
echo "Deployed ${repository}@${digest} in namespace ${NAMESPACE}."
echo "Access: https://${INGRESS_HOST}"
