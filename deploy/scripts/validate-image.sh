#!/usr/bin/env bash
set -euo pipefail

build_id=${BUILD_ID:-local}
[[ "$build_id" =~ ^(local|[0-9]+)$ ]] || { echo 'BUILD_ID must be numeric.' >&2; exit 1; }
image="ipaffs-release-explorer:validate-${build_id}"
container_id=''
cleanup() {
  if [[ -n "$container_id" ]]; then
    docker rm --force "$container_id" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

# Only synthetic configuration is used; this check needs no Azure or ADO access.
docker build --pull --platform linux/amd64 --tag "$image" --file Dockerfile .
container_id=$(docker run --detach --rm --platform linux/amd64 \
  --read-only --cap-drop ALL --security-opt no-new-privileges \
  --env-file .env.example "$image")

# No host port is exposed. Exercise the running image from inside its container.
# shellcheck disable=SC2016
docker exec "$container_id" node --input-type=module -e '
  import assert from "node:assert/strict";
  const base = "http://127.0.0.1:4317";
  let healthy = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const response = await fetch(`${base}/healthz`, {signal: AbortSignal.timeout(1000)});
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {status: "ok", readOnly: true});
      healthy = true;
      break;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  assert.ok(healthy, "Container did not become healthy");
  assert.equal(process.getuid(), 1000, "Container must run as the non-root app user");
  const page = await fetch(`${base}/`, {signal: AbortSignal.timeout(5000)});
  assert.equal(page.status, 200);
  const sample = await fetch(`${base}/api/dashboard?mode=sample`, {signal: AbortSignal.timeout(5000)});
  assert.equal(sample.status, 200);
  assert.equal((await sample.json()).mode, "sample");
  const write = await fetch(`${base}/api/dashboard`, {method: "POST", signal: AbortSignal.timeout(5000)});
  assert.equal(write.status, 405);
  console.log("Container smoke passed: health, UI, sample data, non-root execution and read-only API.");
'
