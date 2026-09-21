#!/usr/bin/env bash

# Source this file to validate the optional setting before deployment and run the
# health check after Helm. This exception applies only to the credential-free GET.
configure_ingress_check() {
  INGRESS_CHECK_CURL_ARGS=(--silent --connect-timeout 10 --max-time 15)
  INGRESS_CHECK_TLS_SKIPPED=false

  # An optional ADO variable remains a literal macro when it is not configured.
  # shellcheck disable=SC2016
  case "${INGRESS_SKIP_TLS_VERIFY:-}" in
    true)
      INGRESS_CHECK_CURL_ARGS+=(--insecure)
      INGRESS_CHECK_TLS_SKIPPED=true
      ;;
    ''|false|'$(ingressSkipTlsVerify)') ;;
    *)
      echo 'INGRESS_SKIP_TLS_VERIFY must be true or false when configured.' >&2
      return 1
      ;;
  esac
}

check_ingress() {
  if [[ "$INGRESS_CHECK_TLS_SKIPPED" == true ]]; then
    echo '##vso[task.logissue type=warning]Certificate verification is disabled only for the DEV ingress health check. Browser, Azure and ADO certificate verification are unchanged.'
  fi

  local attempt http_status curl_code failure_code reason
  # Helm readiness can precede ingress routing updates. Retry the whole check:
  # a default error backend can return HTTP 200 with HTML while routes settle.
  for ((attempt = 1; attempt <= 7; attempt++)); do
    curl_code=0
    failure_code=1
    : > "$DEPLOY_TEMP_DIR/ingress-health.json"
    http_status=$(curl "${INGRESS_CHECK_CURL_ARGS[@]}" \
      --output "$DEPLOY_TEMP_DIR/ingress-health.json" --write-out '%{http_code}' \
      "https://${INGRESS_HOST}/healthz") || curl_code=$?

    if (( curl_code != 0 )); then
      failure_code=$curl_code
      reason="request failed (curl exit ${curl_code})"
    elif [[ "$http_status" != 200 ]]; then
      # Never print arbitrary upstream output in the pipeline log.
      if [[ "$http_status" =~ ^[0-9]{3}$ ]]; then
        reason="HTTP ${http_status}; expected HTTP 200"
      else
        reason='invalid HTTP status; expected HTTP 200'
      fi
    elif ! jq -e '.status == "ok" and .readOnly == true' \
      "$DEPLOY_TEMP_DIR/ingress-health.json" >/dev/null 2>&1; then
      reason='HTTP 200 did not contain the expected application health response'
    else
      if [[ "$INGRESS_CHECK_TLS_SKIPPED" == true ]]; then
        echo 'Ingress HTTPS health check passed with certificate verification disabled.'
      else
        echo 'Ingress HTTPS health check passed with certificate verification enabled.'
      fi
      return 0
    fi

    echo "Ingress health check attempt ${attempt}/7: ${reason}." >&2
    if (( attempt < 7 )); then sleep 5; fi
  done
  echo 'Ingress health check did not reach the release explorer after 7 attempts.' >&2
  return "$failure_code"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  set -euo pipefail
  configure_ingress_check
  check_ingress
fi
