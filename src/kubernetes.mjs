import { readFile } from 'node:fs/promises';
import { request } from 'node:https';
import { mapConcurrent } from './ado-client.mjs';

const SERVICE_ACCOUNT = '/var/run/secrets/kubernetes.io/serviceaccount';
const validNamespace = name => typeof name === 'string' && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name);

// Only exact namespace GETs are supported. Neither the browser nor ADO logs can
// choose a destination, and credentials never leave the in-cluster API server.
export function createNamespaceClient({ readFileImpl = readFile, requestImpl = request, now = Date.now, timeoutMs = 5000 } = {}) {
  async function get(name) {
    // Re-read projected files for each check so kubelet token/CA rotation works
    // without restarting the application.
    const [token, ca] = await Promise.all([
      readFileImpl(`${SERVICE_ACCOUNT}/token`, 'utf8'),
      readFileImpl(`${SERVICE_ACCOUNT}/ca.crt`, 'utf8'),
    ]);
    if (!token.trim() || !ca.trim()) throw new Error('Missing Kubernetes credentials');
    return new Promise((resolve, reject) => {
      const req = requestImpl(new URL(`https://kubernetes.default.svc/api/v1/namespaces/${name}`), {
        method: 'GET', ca, rejectUnauthorized: true,
        headers: { Authorization: `Bearer ${token.trim()}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      }, response => {
        let size = 0;
        const chunks = [];
        response.on('error', reject);
        response.on('data', chunk => {
          size += Buffer.byteLength(chunk);
          if (size > 128 * 1024) {
            req.destroy(new Error('Kubernetes response too large'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            resolve({ status: response.statusCode, body });
          } catch { reject(new Error('Invalid Kubernetes response')); }
        });
      });
      req.on('error', reject);
      req.end();
    });
  }

  return {
    async check(name) {
      const unknown = detail => ({ status: 'unknown', checkedAt: new Date(now()).toISOString(), detail });
      if (!validNamespace(name)) return unknown('The recorded namespace name is invalid; Kubernetes was not queried.');
      try {
        const { status, body } = await get(name);
        const checkedAt = new Date(now()).toISOString();
        if (status === 404 && body?.kind === 'Status' && body.reason === 'NotFound'
          && body.details?.name === name && body.details.kind === 'namespaces') {
          return { status: 'missing', checkedAt, detail: 'Kubernetes confirms this namespace is absent. Any deployment shown here is a historical record; the deletion time is not available.' };
        }
        if (status === 200 && body?.kind === 'Namespace' && body.apiVersion === 'v1' && body.metadata?.name === name) {
          const metadata = {
            uid: typeof body.metadata.uid === 'string' && /^[a-zA-Z0-9-]{1,128}$/.test(body.metadata.uid) ? body.metadata.uid : null,
            createdAt: typeof body.metadata.creationTimestamp === 'string'
              && /^\d{4}-\d{2}-\d{2}T/.test(body.metadata.creationTimestamp)
              && Number.isFinite(Date.parse(body.metadata.creationTimestamp))
              ? body.metadata.creationTimestamp : null,
          };
          if (body.metadata.deletionTimestamp || body.status?.phase === 'Terminating') {
            return { status: 'terminating', checkedAt, ...metadata, detail: 'Kubernetes reports that this namespace is being deleted.' };
          }
          if (body.status?.phase === 'Active') {
            return { status: 'exists', checkedAt, ...metadata, detail: 'Kubernetes confirms this namespace exists. Namespace presence does not establish workload health or the currently deployed version.' };
          }
        }
        return unknown([401, 403].includes(status)
          ? 'Kubernetes did not authorize the namespace check. Its current presence is unknown.'
          : 'Kubernetes did not return a valid namespace result. Its current presence is unknown.');
      } catch {
        // Never expose credentials, upstream bodies or network errors, and never
        // translate an access/transport failure into evidence of deletion.
        return unknown('The Kubernetes namespace check could not be completed. Its current presence is unknown.');
      }
    },
  };
}

export async function attachNamespaceChecks(dashboard, { enabled = false, client, now = Date.now } = {}) {
  if (!enabled) {
    for (const namespace of dashboard.namespaces) namespace.runtime = {
      status: 'unknown', checkedAt: null, detail: 'Kubernetes namespace checks are disabled.',
    };
    dashboard.namespaceChecks = { enabled: false, checkedAt: null, status: 'unavailable' };
    return;
  }
  const names = [...new Set(dashboard.namespaces.map(namespace => namespace.name))];
  // Verify access even when the retained ADO history has no namespace rows.
  const results = await mapConcurrent(names.length ? names : ['dev'], 4, async name => {
    try { return [name, await client.check(name)]; }
    catch {
      return [name, { status: 'unknown', checkedAt: new Date(now()).toISOString(), detail: 'The Kubernetes namespace check could not be completed. Its current presence is unknown.' }];
    }
  });
  const byName = new Map(results);
  for (const namespace of dashboard.namespaces) namespace.runtime = byName.get(namespace.name);
  const verified = results.filter(([, result]) => ['exists', 'missing', 'terminating'].includes(result.status)).length;
  const status = verified === results.length ? 'available' : verified ? 'partial' : 'unavailable';
  dashboard.namespaceChecks = { enabled: true, checkedAt: new Date(now()).toISOString(), status };
  dashboard.coverage.push({ label: 'DEV namespace presence', status,
    detail: 'Read-only Kubernetes checks establish whether the namespace names found in ADO history currently exist. This does not discover namespaces outside that history or establish workload health.' });
  if (status !== 'available') dashboard.warnings.push({ code: 'namespace_checks_unavailable',
    message: 'Some DEV namespace checks could not be completed. Unknown cluster status does not establish that a namespace was deleted.' });
}
