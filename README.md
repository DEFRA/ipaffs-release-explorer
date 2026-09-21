# IPAFFS Release Explorer

A read-only Node app that reconstructs release history from **existing**
ADO run summaries, timelines, selected logs and Environment records. It needs no pipeline
changes, database, GitHub API access or Kubernetes access.

This standalone repository owns the app, its container, the ADO pipeline and its
Helm chart. The new pipeline deploys this app only; existing IPAFFS pipelines
remain its read-only data sources. See [DEV deployment](deploy/README.md) for setup.

## Try it locally

Requirements: Node 24+ and the Azure CLI, signed into an account with read access
to your ADO project. The app has no package dependencies to install.

Copy `.env.example` to `.env` and replace the example organisation, project and
four pipeline IDs with your values. The example IDs are synthetic. Actual
environment configuration stays outside this public repository.

```sh
az login
npm start
```

Open <http://127.0.0.1:4317>. If you already have a working Azure CLI session,
skip the login step. Tokens stay in server memory and are never returned to the
browser. The server only sends GET requests to ADO; there are no queue, deploy,
approve, tag, configuration-write or other mutation routes.

The page initially reads live ADO data. A connection problem stays an error;
sample data is available only through the explicit **Explore sample data** action.
No live log files or credentials are saved in the application directory.

## Data loading and refresh

The browser requests dashboard JSON from the Node server. The server reads ADO,
interprets the pipeline evidence and holds credentials and cached responses in
memory. The browser renders those results; it does not contact ADO or receive
credentials.

Live data refreshes automatically every 3 minutes while the page is visible.
Automatic refresh pauses in a hidden tab and catches up when the page becomes
visible if a refresh is due. Requests do not overlap. Sample data does not
refresh automatically.

Automatic refresh uses the normal dashboard endpoint and its 90-second server
cache. The **Refresh** button remains available to request a new scan immediately.
Individual run evidence is accessible through environment and candidate details.

## What existing data can tell us

| Information | Existing evidence | Limit |
| --- | --- | --- |
| Last recorded deployment in TST/PRE/PRD | Per-environment deployment jobs/stages in the release timeline | A successful pipeline operation is not live cluster health. |
| DEV namespaces deployed by these pipelines | The namespace resolver's `Using namespace:` log line | Deleted or expired logs leave the namespace unknown; this is not a live inventory of namespaces. |
| DEV application launch links | Existing namespace access URL summaries in successful publishing task logs | Only recorded URLs are shown; their availability is not checked. |
| Release candidates and effective manifest commit | Successful Create Release task logs | Tags absent from retained pipeline history cannot be enumerated without another source. |
| Approvals and progress | Native stage results, including incomplete release runs | Overall run status is not the result of every environment. |
| Linked QA result | Child run ID in the existing QA trigger log, then the child's current ADO result | The request does not record the exact manifest revision tested. |
| Failures and reruns | Timeline outcomes and attempts | Older attempts may not be retained; uncertainty is shown rather than guessed. |

Each result includes an ADO link for inspection. The dashboard keeps the last
successful recorded deployment separate from the latest attempt. An older
version deployed later (rollback) can be the last success. No claim is made that
a prior version still runs after a failed deployment or an out-of-band change.

DEV runs without a reliable namespace mapping are silently omitted from the
namespace list. For mapped namespaces, **Open B2C** and **Open B2B** use the
recorded notifications URLs, falling back to recorded base URLs when necessary.
Namespace details show all recorded URLs and the source pipeline run and date.
The most recent successful URL publication is retained even when a newer run
does not publish URLs. A namespace without a matching summary shows **No URLs
recorded**; hostnames are never guessed. Both the older **Publish namespace access
URLs** task and the newer **Generate namespace URLs** task are supported.

Launch links must come from a successful DEV publishing task and job, match the
mapped namespace, and use HTTPS without embedded credentials, query strings or
fragments. The server reads the existing ADO logs only; it does not contact the
application URLs or retrieve the ADO summary web page. Links open in a new tab.

Runs that failed request validation before execution do not produce missing-history
warnings or inferred DEV namespaces. This requires a completed, failed run with
an explicit ADO validation error and a successfully retrieved empty timeline.
The failed run remains available through its evidence link. Failed runs with
deployment records still contribute their actual results; missing history or
access failures continue to produce warnings.

For a linked QA run that ADO reports as not found, the app reads the current
project retention policy through the Build API. If retained QA timestamps are
older than the applicable period and the scan contains enough newer successful
QA runs to exceed the recent-run protection, it shows **Past retention window**.
When only the queue date survives, it shows **Likely past retention window** and
labels the age as an estimate. This appears in both history notices and QA details;
it does not invent a test result or claim to know why the run was removed.

The policy is read once per affected snapshot and refreshed with the dashboard;
no retention periods are hard-coded. Missing policy access, insufficient history,
explicit retention exceptions, and permission or connection failures leave the
result unknown. The minimum-run check follows GitHub-backed pipeline retention.

Environment histories may also contain unrelated infrastructure deployments.
The app uses the configured IPAFFS pipeline identities and their timelines,
without treating a Grafana or other infrastructure deployment as an application
release.

## Candidate progress

Each release candidate shows its progress through DEV, TST, PRE and PRD. The
latest patch is visible while a release series is collapsed; expanding the
series shows progress for every recorded patch. Select an environment to inspect
the matching deployment or approval evidence.

TST/PRE/PRD require both the candidate's exact Git tag and manifest commit to
match a release run. Two tags pointing at the same commit do not inherit each
other's progress. DEV deployments use branch sources, so DEV matches the exact
manifest commit and a recorded namespace; its label is **Commit deployed**.

Progress distinguishes completed deployments, active deployments, approvals,
failures and missing evidence. A later failed attempt does not erase an earlier
successful deployment from the details. **No record** means none was found in
the bounded history scan, not that the candidate has never been deployed.

Abandoned and canceled runs are ignored when reading candidate creation logs
and calculating candidate progress. A candidate is hidden when every matching
release run in
the scan is abandoned. A new tag with no deployment run yet, or a candidate
with an active, successful or failed non-abandoned attempt, stays visible.
Matching uses the exact tag and commit, so abandoning another tag or revision
does not hide the candidate. Canceled runs and their actual deployment history
remain available in the environment overview and its evidence details.

If a release was created with the wrong name, abandon its Create Release run
in ADO to exclude that run's candidate evidence. The app does not guess that a
syntactically valid version is a mistake because it looks unusual or has not
yet been deployed.

ADO can mark a completed run **Abandoned** while retaining its original
successful execution result. Build list and individual-build requests use
`7.2-preview.8`, which exposes the `abandoned` status with managed identity
authentication. That status takes precedence over the original result for
candidate filtering and run display. It is re-read with each history refresh.
The app reads API responses only; it does not fetch authenticated ADO web pages.

This Build summary API version is a preview contract. If a required Build
history request fails, the refresh reports an error instead of silently
falling back to an older API version that may omit abandonment. Timeline, log
and Environment requests retain their existing API versions. Missing deployment
history alone does not hide a candidate.

## Configuration and scope

The server requires an explicit organisation, project and four pipeline IDs:

- `ADO_ORGANIZATION` and `ADO_PROJECT`
- `ADO_DEV_PIPELINE_ID`
- `ADO_CREATE_RELEASE_PIPELINE_ID`
- `ADO_RELEASE_PIPELINE_ID`
- `ADO_QA_PIPELINE_ID`

Copy `.env.example` to `.env` to configure these values, the port or scan
size. The default reads up to 100 recent runs **per pipeline**, plus explicitly
linked QA runs. The UI states its scan limit; it does not claim to represent all
retained history. Set `ADO_RUNS_PER_PIPELINE` between 1 and 100 to adjust the scan size.
Responses are cached in memory for 90 seconds; Refresh requests a new scan.

Authentication preference is `ADO_PAT`, then `ADO_BEARER_TOKEN`, then AKS workload
identity when configured, otherwise the existing Azure CLI session. Supply secrets only through the local environment
or an ignored `.env` file. A read-only credential limits access independently of
the app's GET-only implementation. The PAT needs Build read and Environment read
access; if Environment history is unavailable, timeline results remain usable.

Workload identity exchanges the AKS projected service-account token with Microsoft
Entra for an ADO access token. This authentication exchange is an outbound POST;
ADO history requests remain GET-only. Tokens are renewed and held in memory, and
the projected token file is reread on renewal. Incomplete or failing workload
identity configuration does not fall back to a different account.

The local server binds to `127.0.0.1`; the container binds to `0.0.0.0`. Requests
must match an explicit `ALLOWED_HOSTS` list (hostnames including any port). The
chart supplies local and service DNS addresses and the configured ingress hostname.
This host check is not user authentication. DEV uses the existing internal NGINX
ingress and its shared TLS certificate. Users open the configured HTTPS URL from
the DEV network; port forwarding is optional for diagnostics. Access relies on that
network boundary: anyone who can reach the URL can view the dashboard. There is no
separate app sign-in, and the app's managed identity only authenticates its ADO calls.

## Container option

The included container uses a runtime-supplied token; it does not contain Azure
CLI credentials. To try it with an existing read-only `ADO_PAT` environment value:

```sh
docker build -t ipaffs-release-explorer .
docker run --rm -p 127.0.0.1:4317:4317 --env-file .env --env ADO_PAT ipaffs-release-explorer
```

The image runs as the non-root `node` user. The Helm deployment also uses a
read-only root filesystem, resource limits and process health probes. It needs no
persistent volume or database. The container contains no Azure CLI or credentials;
the AKS workload identity webhook supplies its runtime identity.

The [pipeline](pipeline.yaml) runs tests, validates the chart, and builds and
smoke-tests a Linux/amd64 image for PRs targeting `main`, including draft PRs.
PR checks run on an isolated Microsoft-hosted agent with synthetic configuration.
After a merge or push to `main`, the pipeline repeats validation, pushes an image
to DEV ACR and deploys its digest into the dedicated `ipaffs-release-explorer`
namespace. Azure configuration and deployment stages are included only for `main`
runs. Each DEV deployment creates or updates the app identity and AKS federation,
then passes its IDs directly to Helm. ADO enrollment is a separate one-off step
described in the
[deployment guide](deploy/README.md).

## Tests

```sh
npm test
```

The full suite also needs Bash and jq for the identity provisioning checks, which
use a stub Azure CLI and make no cloud calls. Tests cover interpretation of pipeline evidence, false-success cases, read-only
HTTP behaviour, host validation, workload token exchange/rotation, credential redaction and pagination. The
application uses Node's standard library for both the server and tests.

## API references

- [ADO builds and source refs](https://learn.microsoft.com/en-us/rest/api/azure/devops/build/builds/list?view=azure-devops-rest-7.1)
- [Timeline results and attempts](https://learn.microsoft.com/en-us/rest/api/azure/devops/build/timeline/get?view=azure-devops-rest-7.1)
- [Project retention settings](https://learn.microsoft.com/en-us/rest/api/azure/devops/build/retention/get?view=azure-devops-rest-7.1)
- [Environment deployment records](https://learn.microsoft.com/en-us/rest/api/azure/devops/distributedtask/environmentdeployment-records/list?view=azure-devops-rest-7.1)
- [Azure CLI Entra tokens for ADO](https://learn.microsoft.com/en-us/azure/devops/cli/entra-tokens?view=azure-devops)
- [ADO service principals and managed identities](https://learn.microsoft.com/en-us/azure/devops/integrate/get-started/authentication/service-principal-managed-identity?view=azure-devops)
- [AKS workload identity setup](https://learn.microsoft.com/en-us/azure/aks/workload-identity-deploy-cluster)
