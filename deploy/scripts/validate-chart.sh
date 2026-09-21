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
  --set ingress.enabled=false
)
helm lint "$chart" --strict "${values[@]}"
helm template ipaffs-release-explorer "$chart" --namespace ipaffs-release-explorer \
  "${values[@]}" > "$temp_dir/rendered.yaml"
dev_url_values=(
  --set-string devUrls.b2c=https://notifications.dev.example.test
  --set-string devUrls.b2b=https://notifications-int.dev.example.test/notifications
)
helm template ipaffs-release-explorer "$chart" --namespace ipaffs-release-explorer \
  "${values[@]}" "${dev_url_values[@]}" > "$temp_dir/dev-urls.yaml"
helm template ipaffs-release-explorer "$chart" --namespace ipaffs-release-explorer \
  "${values[@]}" "${dev_url_values[@]}" \
  --set-string devUrls.b2b=https://notifications-int-next.dev.example.test/notifications \
  > "$temp_dir/dev-urls-updated.yaml"

# Render ingress with a different release name to verify it routes to the chart's Service.
ingress_values=(--set ingress.enabled=true --set-string ingress.host=explorer.dev.example.test)
helm lint "$chart" --strict "${values[@]}" "${ingress_values[@]}"
helm template chart-validation "$chart" --namespace validation \
  "${values[@]}" "${ingress_values[@]}" > "$temp_dir/ingress.yaml"
helm template chart-validation "$chart" --namespace validation \
  "${values[@]}" "${ingress_values[@]}" --set-string ingress.tlsSecretName=explorer-tls \
  > "$temp_dir/ingress-secret.yaml"
helm template chart-validation "$chart" --namespace validation \
  "${values[@]}" --set-string ingress.host=explorer.dev.example.test \
  > "$temp_dir/disabled-ingress.yaml"

node --input-type=module - "$temp_dir" <<'NODE'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const directory = process.argv[2];
const read = name => readFileSync(join(directory, name), 'utf8');
const resource = (yaml, kind) => yaml.split(/^---\s*$/m).find(document => document.includes(`\nkind: ${kind}\n`));
const allowedHosts = yaml => {
  const config = resource(yaml, 'ConfigMap');
  return JSON.parse(config.match(/^  ALLOWED_HOSTS: (.+)$/m)[1]).split(',');
};
const configValue = (yaml, name) => JSON.parse(resource(yaml, 'ConfigMap').match(new RegExp(`^  ${name}: (.+)$`, 'm'))[1]);
const configChecksum = yaml => resource(yaml, 'Deployment').match(/^        checksum\/config: (.+)$/m)[1];

const baseline = read('rendered.yaml');
for (const name of ['DEV_B2C_URL', 'DEV_B2B_URL']) {
  assert.equal(configValue(baseline, name), '', 'Canonical DEV links must have no public defaults');
}
const configuredUrls = read('dev-urls.yaml');
assert.equal(configValue(configuredUrls, 'DEV_B2C_URL'), 'https://notifications.dev.example.test');
assert.equal(configValue(configuredUrls, 'DEV_B2B_URL'), 'https://notifications-int.dev.example.test/notifications');
assert.notEqual(configChecksum(baseline), configChecksum(configuredUrls),
  'Configuring canonical DEV links must trigger a rollout');
assert.notEqual(configChecksum(configuredUrls), configChecksum(read('dev-urls-updated.yaml')),
  'Changing a canonical DEV link must trigger a rollout');
assert.deepEqual(allowedHosts(configuredUrls), allowedHosts(baseline),
  'Application launch links must not change the dashboard host allowlist');

for (const name of ['rendered.yaml', 'disabled-ingress.yaml']) {
  const yaml = read(name);
  assert.equal(resource(yaml, 'Ingress'), undefined, `${name}: disabled ingress must not render`);
  assert(!allowedHosts(yaml).some(host => host.startsWith('explorer.dev.example.test')),
    'A disabled ingress must not extend the application host allowlist');
}

for (const name of ['ingress.yaml', 'ingress-secret.yaml']) {
  const yaml = read(name);
  const ingress = resource(yaml, 'Ingress');
  assert(ingress, 'Enabled ingress must render');
  assert.match(ingress, /\napiVersion: networking\.k8s\.io\/v1\n/);
  assert.match(ingress, /nginx\.ingress\.kubernetes\.io\/force-ssl-redirect: "true"/);
  assert.match(ingress, /nginx\.ingress\.kubernetes\.io\/proxy-read-timeout: "300"/);
  assert.match(ingress, /\n  ingressClassName: "nginx"\n/);
  assert.match(ingress, /\n  tls:\n    - hosts:\n        - "explorer\.dev\.example\.test"\n/);
  assert.match(ingress, /\n  rules:\n    - host: "explorer\.dev\.example\.test"\n/);
  assert.match(ingress, /- path: \/\n\s+pathType: Prefix\n\s+backend:\n\s+service:\n\s+name: chart-validation\n\s+port:\n\s+name: http\n/);
  assert.match(resource(yaml, 'Service'), /- name: http\n\s+port: 4317\n/);
  const hosts = allowedHosts(yaml);
  for (const host of ['explorer.dev.example.test', 'explorer.dev.example.test:443',
    'localhost:4317', '127.0.0.1:4317', 'chart-validation.validation.svc:4317']) {
    assert(hosts.includes(host), `Host allowlist must include ${host}`);
  }
  assert(!hosts.includes('explorer.dev.example.test:80'), 'HTTP must redirect before reaching the app');
  assert(!hosts.includes('*'), 'The application host allowlist must remain explicit');
  if (name === 'ingress.yaml') {
    assert(!ingress.includes('secretName:'), 'Default certificate mode must omit secretName');
  } else {
    assert.match(ingress, /\n      secretName: "explorer-tls"\n/);
  }
}
NODE

# Required identity and immutable image configuration must fail closed.
if helm template invalid "$chart" >/dev/null 2>&1; then
  echo 'An unconfigured chart unexpectedly rendered successfully.' >&2
  exit 1
fi
if helm template invalid "$chart" "${values[@]}" --set-string image.digest=latest >/dev/null 2>&1; then
  echo 'An invalid image digest unexpectedly passed chart validation.' >&2
  exit 1
fi

# Invalid ingress settings must fail before reaching Kubernetes or the application.
expect_invalid_ingress() {
  if helm template invalid "$chart" "${values[@]}" "${ingress_values[@]}" "$@" >/dev/null 2>&1; then
    echo "Invalid ingress configuration unexpectedly passed chart validation: $*" >&2
    exit 1
  fi
}
for invalid_host in '' localhost https://explorer.dev.example.test explorer.dev.example.test/path \
  explorer.dev.example.test:443 '*.dev.example.test' Explorer.dev.example.test \
  explorer_dev.example.test explorer..dev.example.test 10.0.0.1; do
  expect_invalid_ingress --set-string "ingress.host=$invalid_host"
done
expect_invalid_ingress --set-string ingress.className=Invalid_Class
expect_invalid_ingress --set-string ingress.tlsSecretName=Invalid_Secret

# Canonical DEV links are optional, but a configured pair must be safe to expose.
expect_invalid_dev_urls() {
  if helm template invalid "$chart" "${values[@]}" "${dev_url_values[@]}" "$@" >/dev/null 2>&1; then
    echo 'Invalid canonical DEV URL configuration unexpectedly passed chart validation.' >&2
    exit 1
  fi
}
for key in b2c b2b; do
  for invalid_url in '' http://notifications.dev.example.test \
    https://user:password@notifications.dev.example.test \
    'https://notifications.dev.example.test?token=example' \
    'https://notifications.dev.example.test/#fragment' \
    'https://notifications.dev.example.test/path with spaces' \
    'https://notifications.dev.example.test/path\backslash'; do
    # --set-file preserves backslashes and whitespace for validation.
    printf '%s' "$invalid_url" > "$temp_dir/invalid-dev-url.txt"
    expect_invalid_dev_urls --set-file "devUrls.${key}=$temp_dir/invalid-dev-url.txt"
  done
done
echo 'Chart lint, routing, TLS, host allowlist, canonical DEV links and required configuration checks passed.'
