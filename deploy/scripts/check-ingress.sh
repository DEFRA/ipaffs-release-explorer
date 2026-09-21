#!/usr/bin/env bash

# Source this file to validate the optional setting before deployment and run the
# health check after Helm. This exception applies only to the credential-free GET.
configure_ingress_check() {
  INGRESS_CHECK_CURL_ARGS=(--fail --silent --show-error --connect-timeout 10 --max-time 15
    --retry 6 --retry-delay 5 --retry-all-errors)
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

  curl "${INGRESS_CHECK_CURL_ARGS[@]}" \
    --output "$DEPLOY_TEMP_DIR/ingress-health.json" "https://${INGRESS_HOST}/healthz" || return "$?"
  if ! jq -e '.status == "ok" and .readOnly == true' "$DEPLOY_TEMP_DIR/ingress-health.json" >/dev/null; then
    echo 'Ingress health check did not reach the release explorer.' >&2
    return 1
  fi

  if [[ "$INGRESS_CHECK_TLS_SKIPPED" == true ]]; then
    echo 'Ingress HTTPS health check passed with certificate verification disabled.'
  else
    echo 'Ingress HTTPS health check passed with certificate verification enabled.'
  fi
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  set -euo pipefail
  configure_ingress_check
  check_ingress
fi
