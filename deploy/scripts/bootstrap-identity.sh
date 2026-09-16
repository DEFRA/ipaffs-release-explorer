#!/usr/bin/env bash
set -euo pipefail

# Preview by default; --apply creates/updates only the dedicated identity and federation.
mode=${1:---what-if}
output_mode=${2:-local}
if [[ $# -gt 2 || ( "$mode" != --what-if && "$mode" != --apply ) ||
      ( "$output_mode" != local && "$output_mode" != --pipeline ) ||
      ( "$output_mode" == --pipeline && "$mode" != --apply ) ]]; then
  echo 'Usage: bash deploy/scripts/bootstrap-identity.sh [--what-if|--apply] [--pipeline (apply only)]' >&2
  exit 1
fi
# shellcheck disable=SC2016
for name in AKS_RESOURCE_GROUP AKS_NAME; do
  if [[ -z "${!name:-}" || "${!name}" == *'$('* ]]; then
    echo "Set ${name} in your local environment before provisioning the identity." >&2
    exit 1
  fi
done
NAMESPACE=${NAMESPACE:-ipaffs-release-explorer}
IDENTITY_NAME=${IDENTITY_NAME:-${NAMESPACE}-dev}
IDENTITY_DEPLOYMENT_NAME=${IDENTITY_DEPLOYMENT_NAME:-release-explorer-identity}
if [[ ! "$NAMESPACE" =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ || ${#NAMESPACE} -gt 63 ]]; then
  echo 'NAMESPACE must be a valid Kubernetes namespace.' >&2
  exit 1
fi
case "$NAMESPACE" in
  dev|tst|pre|prd|default|kube-*) echo 'Use a dedicated namespace for the release explorer.' >&2; exit 1 ;;
esac
if [[ ! "$IDENTITY_NAME" =~ ^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$ ||
      ! "$IDENTITY_DEPLOYMENT_NAME" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$ ]]; then
  echo 'Identity or deployment name is invalid.' >&2
  exit 1
fi

# AzureCLI@2 has already selected the service connection's subscription.
if [[ -z "${AZURE_SUBSCRIPTION:-}" ]]; then
  AZURE_SUBSCRIPTION=$(az account show --query id --output tsv)
fi
# shellcheck disable=SC2016
if [[ -z "$AZURE_SUBSCRIPTION" || "$AZURE_SUBSCRIPTION" == *'$('* ]]; then
  echo 'An authenticated Azure subscription is required.' >&2
  exit 1
fi

script_directory=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
template="$script_directory/../../infrastructure/workload-identity.bicep"
cluster=$(az aks show --subscription "$AZURE_SUBSCRIPTION" --resource-group "$AKS_RESOURCE_GROUP" --name "$AKS_NAME" --output json)
if ! jq -e '.oidcIssuerProfile.enabled == true and .securityProfile.workloadIdentity.enabled == true' <<< "$cluster" >/dev/null; then
  echo 'The existing DEV cluster must have OIDC and Workload Identity enabled.' >&2
  exit 1
fi
issuer=$(jq -er '.oidcIssuerProfile.issuerUrl | select(startswith("https://"))' <<< "$cluster")
arguments=(--subscription "$AZURE_SUBSCRIPTION" --resource-group "$AKS_RESOURCE_GROUP"
  --name "$IDENTITY_DEPLOYMENT_NAME" --mode Incremental --template-file "$template"
  --parameters "identityName=$IDENTITY_NAME" "oidcIssuerUrl=$issuer" "namespace=$NAMESPACE")
if [[ "$mode" == --what-if ]]; then
  az deployment group what-if "${arguments[@]}"
else
  outputs=$(az deployment group create "${arguments[@]}" --query properties.outputs --output json)
  if ! jq -e --arg group "$AKS_RESOURCE_GROUP" --arg name "$IDENTITY_NAME" '
    def uuid: type == "string" and test("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$");
    (.identityClientId.value | uuid) and (.identityTenantId.value | uuid)
    and (.identityPrincipalObjectId.value | uuid)
    and (.identityResourceId.value | split("/")[2] | uuid)
    and (.identityResourceId.value | type == "string"
      and test("^/subscriptions/[0-9a-fA-F-]{36}/resourceGroups/[A-Za-z0-9_.()-]+/providers/Microsoft.ManagedIdentity/userAssignedIdentities/[A-Za-z0-9_-]+$"; "i")
      and (ascii_downcase | endswith(("/resourceGroups/" + $group + "/providers/Microsoft.ManagedIdentity/userAssignedIdentities/" + $name) | ascii_downcase)))
  ' <<< "$outputs" >/dev/null; then
    echo 'Identity deployment did not return valid resource, client, tenant and principal IDs.' >&2
    exit 1
  fi
  resource_id=$(jq -r '.identityResourceId.value' <<< "$outputs")
  client_id=$(jq -r '.identityClientId.value' <<< "$outputs")
  tenant_id=$(jq -r '.identityTenantId.value' <<< "$outputs")
  principal_id=$(jq -r '.identityPrincipalObjectId.value' <<< "$outputs")
  if [[ "$output_mode" == --pipeline ]]; then
    printf '##vso[task.setvariable variable=identityResourceId;isOutput=true;isReadOnly=true]%s\n' "$resource_id"
    printf '##vso[task.setvariable variable=clientId;isOutput=true;isReadOnly=true]%s\n' "$client_id"
    printf '##vso[task.setvariable variable=tenantId;isOutput=true;isReadOnly=true]%s\n' "$tenant_id"
    printf '##vso[task.setvariable variable=principalObjectId;isOutput=true;isReadOnly=true]%s\n' "$principal_id"
  else
    printf 'IDENTITY_RESOURCE_ID=%s\nIDENTITY_CLIENT_ID=%s\nIDENTITY_TENANT_ID=%s\n' "$resource_id" "$client_id" "$tenant_id"
  fi
  printf 'ADO_IDENTITY_PRINCIPAL_OBJECT_ID=%s\n' "$principal_id"
  echo 'Identity and federation are ready. On first setup, an ADO administrator must enrol this principal and grant read access.'
fi
