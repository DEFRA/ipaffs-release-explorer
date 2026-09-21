const FIELDS = new Map([
  ['b2c base url', { kind: 'b2c-base', label: 'B2C base' }],
  ['b2b base url', { kind: 'b2b-base', label: 'B2B base' }],
  ['b2c notifications url', { kind: 'b2c-notifications', label: 'B2C notifications' }],
  ['b2b notifications url', { kind: 'b2b-notifications', label: 'B2B notifications' }],
]);
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s+/;
const validNamespace = value => value.length <= 63 && /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/.test(value);

function safeUrl(value) {
  // The generated summary contains plain HTTPS URLs. Do not accept URL parser
  // repairs, embedded credentials, or query/fragment values that could carry secrets.
  if (!/^https:\/\/[^/?#@]+(?:\/.*)?$/i.test(value) || /[\s\u0000-\u001f\u007f\\?#]/.test(value)) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

function fieldValue(key, value) {
  if (FIELDS.has(key)) return safeUrl(value);
  const plain = value.startsWith('`') && value.endsWith('`') ? value.slice(1, -1) : value;
  if (key === 'environment') return plain.toUpperCase() === 'DEV' ? 'DEV' : null;
  return validNamespace(plain) ? plain : null;
}

// Parsing establishes only what the summary says. The caller must separately
// verify the publishing task succeeded and its namespace matches the deployment.
export function parseNamespaceUrls(logText) {
  if (typeof logText !== 'string') return null;
  const summaries = [];
  let current = null;
  for (const rawLine of logText.split(/\r?\n/)) {
    const line = rawLine.replace(TIMESTAMP, '').trim();
    if (line === '# Namespace access URLs') {
      current = new Map();
      summaries.push(current);
      continue;
    }
    if (/^#{1,6}\s/.test(line)) current = null;
    if (!current) continue;
    const match = line.match(/^-\s+(Environment|Namespace|B2C base URL|B2B base URL|B2C notifications URL|B2B notifications URL):\s*(.*?)\s*$/i);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const value = fieldValue(key, match[2]);
    if (value === null || (current.has(key) && current.get(key) !== value)) return null;
    current.set(key, value);
  }
  if (!summaries.length) return null;

  const combined = new Map();
  for (const summary of summaries) {
    if (!summary.has('environment') || !summary.has('namespace')
      || ![...FIELDS.keys()].some(key => summary.has(key))) return null;
    for (const [key, value] of summary) {
      if (combined.has(key) && combined.get(key) !== value) return null;
      combined.set(key, value);
    }
  }
  const links = [...FIELDS].filter(([key]) => combined.has(key))
    .map(([key, metadata]) => ({ ...metadata, url: combined.get(key) }));
  return { namespace: combined.get('namespace'), environment: combined.get('environment'), links };
}
