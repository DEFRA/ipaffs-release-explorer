targetScope = 'resourceGroup'

@description('Name of the dedicated identity used only by the release explorer.')
param identityName string = 'ipaffs-release-explorer-dev'

param location string = resourceGroup().location

@description('OIDC issuer URL from the existing DEV AKS cluster, including its trailing slash.')
param oidcIssuerUrl string

param namespace string = 'ipaffs-release-explorer'
param serviceAccountName string = 'ipaffs-release-explorer'

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = {
  name: identityName
  location: location
  tags: {
    service: 'ipaffs-release-explorer'
    environment: 'DEV'
  }
}

resource federation 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2024-11-30' = {
  parent: identity
  name: 'dev-aks'
  properties: {
    issuer: oidcIssuerUrl
    subject: 'system:serviceaccount:${namespace}:${serviceAccountName}'
    audiences: ['api://AzureADTokenExchange']
  }
}

// ADO access is granted in the ADO organisation/project, not with Azure resource roles.
output identityResourceId string = identity.id
output identityClientId string = identity.properties.clientId
output identityTenantId string = identity.properties.tenantId
output identityPrincipalObjectId string = identity.properties.principalId
