import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798';
// This Build summary version exposes status: abandoned even when the original
// execution result remains succeeded. Timelines and logs use their own versions.
const BUILD_SUMMARY_API_VERSION = '7.2-preview.8';

export class AdoError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function workloadConfiguration(env) {
  const keys = ['AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_FEDERATED_TOKEN_FILE'];
  if (!keys.some(key => env[key] !== undefined)) return null;
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  if (!uuid.test(env.AZURE_TENANT_ID || '') || !uuid.test(env.AZURE_CLIENT_ID || '')
    || typeof env.AZURE_FEDERATED_TOKEN_FILE !== 'string' || !isAbsolute(env.AZURE_FEDERATED_TOKEN_FILE)
    || (env.AZURE_AUTHORITY_HOST && !/^https:\/\/login\.microsoftonline\.com\/?$/.test(env.AZURE_AUTHORITY_HOST))) {
    throw new AdoError('workload_identity_configuration', 'Workload identity is not fully configured. Check the pod identity environment and service account.', 503);
  }
  return { tenant: env.AZURE_TENANT_ID, client: env.AZURE_CLIENT_ID, file: env.AZURE_FEDERATED_TOKEN_FILE };
}

async function exchangeWorkloadToken(identity, { fetchImpl, readTokenFile, now }) {
  try {
    const signal = AbortSignal.timeout(30000);
    // AKS rotates the projected token. Read it for every renewal, never cache it.
    const assertion = (await readTokenFile(identity.file, { encoding: 'utf8', signal })).trim();
    if (!assertion || assertion.length > 65536) throw new Error('Invalid assertion');
    const started = now();
    // OAuth authentication is the sole outbound POST; ADO data remains GET-only.
    // https://learn.microsoft.com/entra/identity-platform/v2-oauth2-client-creds-grant-flow
    const response = await fetchImpl(`https://login.microsoftonline.com/${identity.tenant}/oauth2/v2.0/token`, {
      method: 'POST', redirect: 'error', signal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        client_id: identity.client,
        scope: `${RESOURCE}/.default`,
        grant_type: 'client_credentials',
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: assertion,
      }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('Identity denied');
    }
    let size = 0;
    const chunks = [];
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 1024 * 1024) throw new Error('Invalid identity response');
      chunks.push(chunk);
    }
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const lifetime = Number(result.expires_in);
    if (typeof result.access_token !== 'string' || !result.access_token.trim() || /[\r\n]/.test(result.access_token)
      || String(result.token_type).toLowerCase() !== 'bearer' || !Number.isFinite(lifetime) || lifetime <= 0) {
      throw new Error('Invalid identity response');
    }
    const expires = started + lifetime * 1000;
    if (!Number.isFinite(expires) || expires <= now()) throw new Error('Expired identity response');
    return { token: result.access_token, expires };
  } catch {
    // Never disclose assertions, access tokens, token-file paths, or Entra errors.
    throw new AdoError('workload_identity_unavailable', 'Workload identity sign-in failed. Check the managed identity federation and pod configuration.', 503);
  }
}

export function createTokenProvider({ env = process.env, executeFile = execute, fetchImpl = fetch, readTokenFile = readFile, now = Date.now } = {}) {
  let cached;
  let pending;
  return async function authorization() {
    if (env.ADO_PAT) return `Basic ${Buffer.from(`:${env.ADO_PAT}`).toString('base64')}`;
    if (env.ADO_BEARER_TOKEN) return `Bearer ${env.ADO_BEARER_TOKEN}`;
    // Do not silently fall back to a different account after a pod configuration error.
    const identity = workloadConfiguration(env);
    if (cached && cached.expires > now() + 120000) return `Bearer ${cached.token}`;
    if (!pending) {
      pending = Promise.resolve().then(async () => {
        if (identity) {
          cached = await exchangeWorkloadToken(identity, { fetchImpl, readTokenFile, now });
          return `Bearer ${cached.token}`;
        }
        try {
          const { stdout } = await executeFile('az', ['account', 'get-access-token', '--resource', RESOURCE, '--output', 'json'], {
            timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true,
          });
          const result = JSON.parse(stdout);
          if (typeof result.accessToken !== 'string' || !result.accessToken) throw new Error('Missing access token');
          cached = { token: result.accessToken, expires: Number(result.expires_on) * 1000 || now() + 300000 };
          return `Bearer ${cached.token}`;
        } catch {
          // Azure CLI stderr can contain account details. Never return it to the browser.
          throw new AdoError('sign_in_required', 'Azure sign-in is unavailable. Run az login locally, or supply ADO_PAT to the server with read access to this project.', 503);
        }
      }).finally(() => { pending = undefined; });
    }
    return pending;
  };
}

export class AdoClient {
  constructor(config, { fetchImpl = fetch, authorization = createTokenProvider() } = {}) {
    this.base = `${config.organization}/${encodeURIComponent(config.project)}/_apis/`;
    this.fetchImpl = fetchImpl;
    this.authorization = authorization;
    this.requests = 0;
  }

  async get(path, query = {}, { text = false } = {}) {
    // This is deliberately not an arbitrary URL proxy. All network operations are GET.
    if (!/^(?:build|distributedtask)\/[A-Za-z0-9/_-]+$/.test(path)) throw new Error('Unsupported ADO API path');
    const url = new URL(path, this.base);
    url.searchParams.set('api-version', /^build\/builds(?:\/\d+)?$/.test(path) ? BUILD_SUMMARY_API_VERSION : '7.1');
    for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, String(value));
    return this.#request(url, { accept: text ? 'text/plain' : 'application/json', text, limit: text ? 4 * 1024 * 1024 : 12 * 1024 * 1024 });
  }

  async #request(url, { accept, text, limit }) {
    const authorization = await this.authorization();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let response;
      try {
        this.requests += 1;
        response = await this.fetchImpl(url, {
          method: 'GET', redirect: 'error', signal: AbortSignal.timeout(20000),
          headers: { Authorization: authorization, Accept: accept },
        });
      } catch {
        throw new AdoError('connection_failed', 'Could not reach Azure DevOps. Check your connection and try refreshing.');
      }
      if (response.status === 429 && attempt === 0) {
        await response.body?.cancel();
        const delay = Math.min(Math.max(Number(response.headers.get('retry-after')) || 1, 1), 3);
        await new Promise(resolve => setTimeout(resolve, delay * 1000));
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 401 || response.status === 403) throw new AdoError('access_denied', 'Azure DevOps denied access. Check the signed-in account and its read permissions for this project.', response.status);
        throw new AdoError('ado_response_error', `Azure DevOps returned HTTP ${response.status} for a history request.`, response.status === 404 ? 404 : 502);
      }
      let size = 0;
      const chunks = [];
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > limit) throw new AdoError('response_too_large', 'A history response exceeded the local read limit.');
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks).toString('utf8');
      let data;
      try { data = text ? body : JSON.parse(body); } catch { throw new AdoError('invalid_response', 'Azure DevOps returned an unexpected response.'); }
      return { data, continuation: response.headers.get('x-ms-continuationtoken') };
    }
    throw new AdoError('rate_limited', 'Azure DevOps is busy. Try again shortly.');
  }

  async list(path, query = {}, limit = 100) {
    const items = [];
    let continuation;
    let pages = 0;
    do {
      const top = path.endsWith('/environmentdeploymentrecords') ? 'top' : '$top';
      const response = await this.get(path, { ...query, [top]: Math.min(100, limit - items.length), continuationToken: continuation });
      if (!Array.isArray(response.data.value)) throw new AdoError('invalid_response', 'Azure DevOps returned an unexpected history list.');
      items.push(...response.data.value.slice(0, limit - items.length));
      continuation = response.continuation;
      pages += 1;
    } while (continuation && items.length < limit && pages < 10);
    return { items, limited: Boolean(continuation) || items.length >= limit };
  }
}

export async function mapConcurrent(items, concurrency, operation) {
  let cursor = 0;
  const result = new Array(items.length);
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      result[index] = await operation(items[index], index);
    }
  }));
  return result;
}
