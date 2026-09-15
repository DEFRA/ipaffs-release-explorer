#!/usr/bin/env bash
set -euo pipefail

# Preview by default; --apply creates/updates only the dedicated identity and federation.
mode=${1:---what-if}
if [[ "$mode" != --what-if && "$mode" != --apply ]]; then
  echo 'Usage: bash deploy/scripts/bootstrap-identity.sh [--what-if|--apply]' >&2
  exit 1
fi
for name in AZURE_SUBSCRIPTION AKS_RESOURCE_GROUP AKS_NAME; do
  if [[ -z "${!name:-}" ]]; then
    echo "Set ${name} in your local environment before provisioning the identity." >&2
    exit 1
  fi
done
NAMESPACE=${NAMESPACE:-ipaffs-release-explorer}
IDENTITY_NAME=${IDENTITY_NAME:-ipaffs-release-explorer-dev}
if [[ ! "$NAMESPACE" =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ || ${#NAMESPACE} -gt 63 ]]; then
  echo 'NAMESPACE must be a valid Kubernetes namespace.' >&2
  exit 1
fi
case "$NAMESPACE" in
  dev|tst|pre|prd|default|kube-*) echo 'Use a dedicated namespace for the release explorer.' >&2; exit 1 ;;
esac

script_directory=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
template="$script_directory/../../infrastructure/workload-identity.bicep"
cluster=$(az aks show --subscription "$AZURE_SUBSCRIPTION" --resource-group "$AKS_RESOURCE_GROUP" --name "$AKS_NAME" --output json)
if ! jq -e '.oidcIssuerProfile.enabled == true and .securityProfile.workloadIdentity.enabled == true' <<< "$cluster" >/dev/null; then
  echo 'The existing DEV cluster must have OIDC and Workload Identity enabled.' >&2
  exit 1
fi
issuer=$(jq -er '.oidcIssuerProfile.issuerUrl | select(startswith("https://"))' <<< "$cluster")
arguments=(--subscription "$AZURE_SUBSCRIPTION" --resource-group "$AKS_RESOURCE_GROUP"
  --name release-explorer-identity --template-file "$template"
  --parameters "identityName=$IDENTITY_NAME" "oidcIssuerUrl=$issuer" "namespace=$NAMESPACE")
if [[ "$mode" == --what-if ]]; then
  az deployment group what-if "${arguments[@]}"
else
  outputs=$(az deployment group create "${arguments[@]}" --query properties.outputs --output json)
  jq -r '"RELEASE_EXPLORER_IDENTITY_RESOURCE_ID=\(.identityResourceId.value)",
    "RELEASE_EXPLORER_IDENTITY_CLIENT_ID=\(.identityClientId.value)",
    "RELEASE_EXPLORER_IDENTITY_TENANT_ID=\(.identityTenantId.value)",
    "ADO_IDENTITY_PRINCIPAL_OBJECT_ID=\(.identityPrincipalObjectId.value)"' <<< "$outputs"
  echo 'Add the identity to the ADO organisation/project with read access, then set the three RELEASE_EXPLORER variables on the pipeline.'
fi
