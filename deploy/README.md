# Deploy to DEV

The repository contains one application and its complete delivery configuration:

| File | Purpose |
| --- | --- |
| `Dockerfile` | Node 24 runtime, no package dependencies or embedded credentials |
| `pipeline.yaml` | Test, build, push to ACR, deploy to DEV |
| `deploy/helm/ipaffs-release-explorer` | Self-contained Helm chart |
| `deployment/dev/values.yaml` | DEV app configuration and resource sizes |
| `infrastructure/workload-identity.bicep` | Dedicated managed identity and AKS federation |
| `deploy/scripts/bootstrap-identity.sh` | Reconcile the app identity before Helm; also supports a local preview |

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
| `ingressHost` | Full internal DNS hostname covered by the NGINX controller's certificate |
| `ingressSkipTlsVerify` | Optional: exact `true` skips certificate verification only for the DEV ingress health check; omitted or `false` verifies certificates |
| `ADO_ORGANIZATION` | `https://dev.azure.com/<your-organisation>` |
| `ADO_PROJECT` | Project containing IPAFFS pipeline history |
| `ADO_DEV_PIPELINE_ID` | DEV deployment pipeline ID |
| `ADO_CREATE_RELEASE_PIPELINE_ID` | Release creation pipeline ID |
| `ADO_RELEASE_PIPELINE_ID` | Release deployment pipeline ID |
| `ADO_QA_PIPELINE_ID` | QA pipeline ID |

Identity IDs are outputs of the deployment job. Do not add them to the variable
group; the pipeline obtains them from Azure on every deployment.

The pipeline uses ADO deployment environment `DEV` and image repository
`ipaffs/ipaffs-release-explorer`. Actual ADO settings are injected during deployment
through a temporary values file; the published chart contains no environment IDs.

Use an agent in that pool which can reach the private AKS API and ACR, and has
Docker, Azure CLI, Bash, jq and curl. Publishing and deployment use this private pool;
validation uses a Microsoft-hosted `ubuntu-24.04` agent and needs hosted parallel
job capacity. The pipeline installs Node, Helm, kubectl and
kubelogin. Authorise the new pipeline to use the variable group, agent pool,
service connection and DEV environment. Existing environment checks still apply.

There are three separate identities involved:

- **Pipeline service connection:** builds/pushes the image and deploys the chart.
  It needs ACR push access, permission to obtain non-admin AKS credentials and
  Kubernetes permissions to create the new namespace and manage its Helm resources.
  It also needs permission to create/update the app managed identity and federated
  credential, run resource-group ARM deployments, read the AKS configuration, and
  create/update the app Ingress and execute the post-deployment check in the pod (`pods/exec`). The namespace-scoped
  identity receives no Azure resource roles from this template.
- **AKS kubelet identity:** pulls the image from ACR. It needs `AcrPull`, or the
  appropriate repository-reader role if the registry uses repository ABAC.
- **App managed identity:** reads ADO. It needs ADO permissions, not Azure
  Contributor, Kubernetes roles or GitHub access.

## 1. Pipeline-managed app identity

The existing AKS cluster must have OIDC and Workload Identity enabled. The bootstrap
script checks both. Before Helm runs, the DEV deployment job uses the existing
Azure service connection to deploy `infrastructure/workload-identity.bicep` in
incremental mode. It creates or updates:

- the managed identity named `<namespace>-dev`;
- its `dev-aks` federated credential, using the existing cluster's issuer and the
  release explorer service account.

With the default namespace the identity is `ipaffs-release-explorer-dev`. Keeping
the same resource group and namespace reuses the same identity on later runs,
preserving its ADO membership. Changing namespace creates a separate identity;
it does not redirect the original identity's federation. Each pipeline run has
its own ARM deployment name to avoid clashing with other build records.

The task validates Azure's resource, client, tenant and principal IDs, then passes
the required IDs directly to the Helm deployment step as job outputs. There are
no identity IDs to copy into ADO variables. Incremental deployment updates the
declared resources without deleting other resources in the group.

For the default namespace, federation is scoped to:

```text
system:serviceaccount:ipaffs-release-explorer:ipaffs-release-explorer
```

The pipeline does not change the cluster or grant directory/ADO permissions.
Helm creates the namespace when installing the app. It is also possible to preview
or provision the identity ahead of the pipeline: set `AKS_RESOURCE_GROUP` and
`AKS_NAME` in your shell, sign into the correct subscription, then run:

```sh
bash deploy/scripts/bootstrap-identity.sh --what-if
bash deploy/scripts/bootstrap-identity.sh --apply
```

The local script defaults to preview mode. `AZURE_SUBSCRIPTION` can explicitly
select another subscription; otherwise it uses the current Azure CLI subscription,
just as it uses the service connection's subscription in the pipeline. Set
`NAMESPACE` to match any non-default pipeline namespace. Local callers can also
override `IDENTITY_NAME` and `IDENTITY_DEPLOYMENT_NAME`; use the pipeline's naming
convention when provisioning an identity for it to reuse.

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

The identity task prints `ADO_IDENTITY_PRINCIPAL_OBJECT_ID` for this registration.
On the first run, Azure provisioning can complete before an ADO administrator
has enrolled the identity. The app's ADO check will then fail. Grant its access
and rerun the DEV stage; the existing identity is reused. Alternatively, run the
local bootstrap once, enrol that identity, and then start the full pipeline.
If the identity is deleted/recreated, or a different namespace is selected, its
new principal must be enrolled separately.

The app reads abandoned status from Build summary API `7.2-preview.8`, using
the managed identity. It does not fetch authenticated ADO web pages. Required
Build history failures are reported as errors rather than using an older API
version that may omit abandoned status.

Allow pod HTTPS egress and DNS for `login.microsoftonline.com` and `dev.azure.com`.
The deployment agent separately needs access to ACR, AKS, tool download hosts and
the internal ingress hostname over HTTPS.
Check any inherited namespace or cluster network policy before the first run.

## 3. Register and run the ADO pipeline

Create a YAML pipeline in your ADO project, select this GitHub repository through
the existing authorised GitHub connection, and select `/pipeline.yaml` on `main`.
Populate and authorise `ReleaseExplorerDEV` before the first deployment. Identity
IDs are produced by the pipeline rather than required as configuration.

The pipeline runs automatically as follows:

| Event | Behaviour |
| --- | --- |
| PR targeting `main`, including drafts | Tests, chart/identity-template validation, container build and sample-data smoke check |
| Another commit on the same PR | New validation; superseded PR validation is cancelled |
| Merge or direct push to `main` | Validation, ACR publication and DEV deployment |
| Manual run on `main` | The same validation, publication and deployment |
| Manual run on another branch | Validation only |

The PR path uses synthetic `.env.example` values and a disposable hosted agent.
The DEV variable group, Azure tasks and private agent pool are omitted during
template expansion for PR and non-main runs. Publishing and deployment also check
the source branch and build reason before running.

For the public repository, keep ADO's **Make secrets available to builds of forks**
and **Make fork builds have the same permissions as regular builds** settings
disabled. Use resource-level branch-control checks allowing only
`refs/heads/main` on the Azure service connection, private agent pool and DEV
environment. YAML conditions describe normal behaviour; PR authors can
change that YAML, so resource permissions and checks must enforce access outside
the repository. Fork PR runs may also require project policy enablement or a
team-member comment; the YAML trigger does not override those settings. See
Microsoft's [GitHub pipeline guidance](https://learn.microsoft.com/en-us/azure/devops/pipelines/repos/github?view=azure-devops).

Complete pipeline resource authorisation before the first merge into `main`.
ADO identity enrollment must be complete before the live-data check can pass.
For automatic triggering, register this YAML with ADO and leave UI trigger
overrides disabled. A run on `main`:

1. Runs the tests, validates the chart and identity template, builds the container and checks its
   health, page and sample data with the restricted runtime settings.
2. Builds Linux/amd64 and pushes `build-<ADO Build ID>` to the existing DEV ACR.
3. Publishes the chart, DEV values, commit and resolved image digest as a pipeline
   artifact. The deploy stage uses that artifact and digest.
4. Creates or updates the managed identity and federation and reads their IDs.
5. Verifies cluster identity settings and federation, then installs/upgrades the
   chart in the dedicated namespace with a ten-minute readiness timeout.
6. Checks the ingress URL (verifying certificates by default), then checks live ADO reads
   from the running pod. A freshly provisioned identity gets
   a bounded retry for token-exchange propagation. An authentication or permissions
   failure must be resolved before treating the deployment as ready for use.

`helm --atomic` rolls back a failed Helm upgrade. A later ingress or ADO smoke-check failure
fails the pipeline but leaves the installed revision available for diagnosis;
it does not automatically roll back that revision.

## 4. Open it

Open `https://<ingressHost>` from a machine with access to the DEV network. The
pipeline prints the actual URL after deployment. Normal use requires no local
process or Kubernetes port forwarding.

The DEV values enable an Ingress on the existing `nginx` class. It routes `/` to
the app's ClusterIP service, redirects HTTP to HTTPS, and permits the exact browser
hostname (including an explicit `:443`) in the app's Host allowlist. The 300-second
NGINX read timeout accommodates the first ADO history scan.

Supply the real hostname only through `ingressHost` in `ReleaseExplorerDEV`; keep
it out of this public repository. Point that hostname at the existing internal
load balancer, or use a name already covered by the environment's wildcard DNS.
The chart does not create DNS records or a new ingress controller.

By default `ingress.tlsSecretName` is empty: the Ingress declares TLS hosts but
omits `secretName`, allowing NGINX to use its configured default certificate. This
avoids copying certificate material into the app namespace. The shared certificate
must cover the chosen hostname and be trusted by browsers and the deployment
agent. If a different certificate is needed, set `ingress.tlsSecretName` to an
existing TLS Secret in the app namespace. The chart does not create that Secret.
See the [NGINX default certificate documentation](https://github.com/kubernetes/ingress-nginx/blob/main/docs/user-guide/tls.md#default-ssl-certificate).

The deployment checks HTTPS `/healthz` from the DEV agent with certificate
verification by default. While a DEV certificate mismatch is being resolved,
set `ingressSkipTlsVerify=true` in the variable group to skip certificate
verification for this unauthenticated health request only. The run emits a
warning and still checks HTTP success and the application's JSON health response.
Azure and ADO authentication retain normal TLS verification, and browsers will
still warn about an invalid certificate. Set the variable to `false` or remove it
when the certificate is corrected. Invalid values fail before deployment.

DNS and routing failures, unhealthy responses, and certificate failures when
verification is enabled fail the run; this does not
roll back a Helm installation that already succeeded.

Access relies on the DEV network boundary. NGINX provides routing and TLS, not a
user sign-in: anyone who can reach this URL can view the dashboard's ADO data. The
app managed identity authenticates backend ADO requests only. Keep the ingress on
the internal controller; broader exposure needs a separate access-control design.

Port forwarding remains an optional diagnostic fallback for users with DEV
Kubernetes access permitting `pods/portforward`:

```sh
kubectl --namespace ipaffs-release-explorer port-forward service/ipaffs-release-explorer 4317:4317
```

Open <http://127.0.0.1:4317>. Stop the local Node app first if it already uses that port.

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
