# Deploy to DEV

The repository contains one application and its complete delivery configuration:

| File | Purpose |
| --- | --- |
| `Dockerfile` | Node 24 runtime, no package dependencies or embedded credentials |
| `pipeline.yaml` | Test, build, push to ACR, deploy to DEV |
| `deploy/helm/ipaffs-release-explorer` | Self-contained Helm chart |
| `deployment/dev/values.yaml` | DEV app configuration and resource sizes |
| `infrastructure/workload-identity.bicep` | Dedicated managed identity and AKS federation |
| `deploy/scripts/bootstrap-identity.sh` | Preview/apply identity setup against the existing DEV cluster |

The Helm release, namespace and Kubernetes service account default to
`ipaffs-release-explorer`. This namespace has its own configuration and does not
depend on the canonical IPAFFS namespace. The app reads ADO only; it receives no
Kubernetes API role and has no access to the TST, PRE or PRD clusters.

## Existing DEV resources

Create a non-secret ADO variable group named **ReleaseExplorerDEV** and authorise
this pipeline to read it. Keep actual environment identifiers in ADO, outside this
public repository. Populate it from your existing DEV configuration:

| Setting | Value |
| --- | --- |
| `agentPool` | Existing agent pool with access to DEV AKS and ACR |
| `serviceConnection` | Existing DEV Azure service connection name |
| `resourceGroupName` | DEV AKS resource group |
| `kubernetesCluster` | DEV AKS name |
| `acrName` | Existing DEV ACR name |
| `ADO_ORGANIZATION` | `https://dev.azure.com/<your-organisation>` |
| `ADO_PROJECT` | Project containing IPAFFS pipeline history |
| `ADO_DEV_PIPELINE_ID` | DEV deployment pipeline ID |
| `ADO_CREATE_RELEASE_PIPELINE_ID` | Release creation pipeline ID |
| `ADO_RELEASE_PIPELINE_ID` | Release deployment pipeline ID |
| `ADO_QA_PIPELINE_ID` | QA pipeline ID |
| `RELEASE_EXPLORER_IDENTITY_RESOURCE_ID` | Resource ID from identity setup |
| `RELEASE_EXPLORER_IDENTITY_CLIENT_ID` | Client ID from identity setup |
| `RELEASE_EXPLORER_IDENTITY_TENANT_ID` | Tenant ID from identity setup |

The pipeline uses ADO deployment environment `DEV` and image repository
`ipaffs/ipaffs-release-explorer`. Actual ADO settings are injected during deployment
through a temporary values file; the published chart contains no environment IDs.

Use an agent in that pool which can reach the private AKS API and ACR, and has
Docker, Azure CLI, Bash and jq. The pipeline installs Node, Helm, kubectl and
kubelogin. Authorise the new pipeline to use the variable groups, agent pool,
service connection and DEV environment. Existing environment checks still apply.

There are three separate identities involved:

- **Pipeline service connection:** builds/pushes the image and deploys the chart.
  It needs ACR push access, permission to obtain non-admin AKS credentials and
  Kubernetes permissions to create the new namespace and manage its Helm resources.
  It also reads the cluster and managed-identity configuration for preflight checks.
- **AKS kubelet identity:** pulls the image from ACR. It needs `AcrPull`, or the
  appropriate repository-reader role if the registry uses repository ABAC.
- **App managed identity:** reads ADO. It needs ADO permissions, not Azure
  Contributor, Kubernetes roles or GitHub access.

## 1. Create the app identity

The existing AKS cluster must have OIDC and Workload Identity enabled. The bootstrap
script checks both. Set `AZURE_SUBSCRIPTION`, `AKS_RESOURCE_GROUP` and `AKS_NAME`
in your shell to the actual DEV values. From this repository, signed into that
subscription:

```sh
bash deploy/scripts/bootstrap-identity.sh --what-if
bash deploy/scripts/bootstrap-identity.sh --apply
```

This creates/updates `ipaffs-release-explorer-dev` and a `dev-aks` federated
credential. It does not change the cluster, create a namespace or grant Azure
roles. Federation is scoped to:

```text
system:serviceaccount:ipaffs-release-explorer:ipaffs-release-explorer
```

To choose another dedicated namespace, set `NAMESPACE` when running the script
and use the same namespace pipeline parameter. The script also accepts
`AZURE_SUBSCRIPTION`, `AKS_RESOURCE_GROUP`, `AKS_NAME` and `IDENTITY_NAME` overrides.
The cluster issuer URL is read from Azure rather than copied into source control.

Save the three non-secret `RELEASE_EXPLORER_IDENTITY_*` output values in the
`ReleaseExplorerDEV` variable group. The principal object ID output is for ADO enrollment.

## 2. Give the identity ADO read access

An ADO organisation administrator must add the managed identity to the configured
organisation using its **principal object ID**, then give it read access to the
configured project. Project Readers is the starting point; check any explicit
pipeline/Environment permission overrides. It must be able to view:

- the four configured pipelines, their runs, timelines and logs;
- the DEV/TST/PRE/PRD Environment records;
- authenticated run details pages, used to verify abandoned status.

The identity must be in the Entra tenant connected to the ADO organisation.
Azure RBAC alone does not grant these permissions. Follow Microsoft's
[ADO managed-identity setup](https://learn.microsoft.com/en-us/azure/devops/integrate/get-started/authentication/service-principal-managed-identity?view=azure-devops).
No PAT or bearer-token secret is required in Helm values or the pipeline.

The abandoned-status page provider is not a public REST contract. Managed-identity
access to it must be verified on the first deployment. The dashboard reports
missing state rather than inventing candidates if this read fails.

Allow pod HTTPS egress and DNS for `login.microsoftonline.com` and `dev.azure.com`.
The deployment agent separately needs access to ACR, AKS and tool download hosts.
Check any inherited namespace or cluster network policy before the first run.

## 3. Register and run the ADO pipeline

Create a YAML pipeline in your ADO project, select this GitHub repository through
the existing authorised GitHub connection, and select `/pipeline.yaml` on `main`.
Set the identity outputs in the variable group before the first run:

```text
RELEASE_EXPLORER_IDENTITY_RESOURCE_ID
RELEASE_EXPLORER_IDENTITY_CLIENT_ID
RELEASE_EXPLORER_IDENTITY_TENANT_ID
```

The file uses manual triggers initially. Queue it after identity and resource
authorisation are complete. It:

1. Runs the app tests and validates the chart.
2. Builds Linux/amd64 and pushes `build-<ADO Build ID>` to the existing DEV ACR.
3. Publishes the chart, DEV values, commit and resolved image digest as a pipeline
   artifact. The deploy stage uses that artifact and digest.
4. Verifies cluster identity settings and federation, then installs/upgrades the
   chart in the dedicated namespace with a ten-minute readiness timeout.
5. Checks live ADO reads from the running pod. An authentication or permissions
   failure must be resolved before treating the deployment as ready for use.

`helm --atomic` rolls back a failed Helm upgrade. A later ADO smoke-check failure
fails the pipeline but leaves the installed revision available for diagnosis;
it does not automatically roll back that revision.

## 4. Open it

With your normal DEV Kubernetes access:

```sh
kubectl --namespace ipaffs-release-explorer port-forward service/ipaffs-release-explorer 4317:4317
```

Open <http://127.0.0.1:4317>. Stop the local Node app first if it already uses that
port. The chart creates a ClusterIP service; it does not create a public endpoint
or ingress. Cluster users who can reach the service can see its ADO data.

For a shared URL, add your approved internal ingress, TLS and user authentication,
then include the exact browser host/port in the chart's additional allowed hosts.
The backend workload identity authenticates to ADO; it does not sign browser users in.

## Local checks

```sh
npm test
bash deploy/scripts/validate-chart.sh
az bicep build --file infrastructure/workload-identity.bicep --outfile /tmp/release-explorer-identity.json
docker build --platform linux/amd64 -t ipaffs-release-explorer:local .
```

The chart validation script uses dummy IDs and a dummy digest for rendering only.
The real pipeline supplies verified identity IDs and the digest from ACR.
Process health checks do not call ADO, so an ADO outage does not restart healthy pods.

## Roll back or remove

Inspect Helm history and choose a known working revision:

```sh
helm history ipaffs-release-explorer --namespace ipaffs-release-explorer
helm rollback ipaffs-release-explorer <revision> --namespace ipaffs-release-explorer --wait
```

To remove the app, use `helm uninstall ipaffs-release-explorer --namespace
ipaffs-release-explorer`. Namespace, managed identity, federation and ADO membership
are separate lifecycle resources and remain until explicitly removed.
