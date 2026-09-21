import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNamespaceUrls } from '../src/namespace-urls.mjs';

const summary = `# Namespace access URLs
- Environment: \`DEV\`
- Namespace: \`feature-123\`
- B2C base URL: https://b2c.example.invalid
- B2B base URL: https://b2b.example.invalid
- B2C notifications URL: https://b2c.example.invalid/notification/DEV/protected/notifications
- B2B notifications URL: https://b2b.example.invalid/notification/DEV/protected/notifications`;
const timestamped = text => text.split('\n').map(line => `2035-06-01T12:00:00.1234567Z ${line}`).join('\r\n');

test('reads the published markdown summary inside an ADO timestamped task log', () => {
  const result = parseNamespaceUrls(timestamped(`Starting task\nNamespace access URLs\n${summary}\nTask complete`));
  assert.deepEqual(result, {
    namespace: 'feature-123', environment: 'DEV', links: [
      { kind: 'b2c-base', label: 'B2C base', url: 'https://b2c.example.invalid/' },
      { kind: 'b2b-base', label: 'B2B base', url: 'https://b2b.example.invalid/' },
      { kind: 'b2c-notifications', label: 'B2C notifications', url: 'https://b2c.example.invalid/notification/DEV/protected/notifications' },
      { kind: 'b2b-notifications', label: 'B2B notifications', url: 'https://b2b.example.invalid/notification/DEV/protected/notifications' },
    ],
  });
});

test('accepts DEV case variants, bare metadata, and only the subset of URLs actually published', () => {
  const partial = '# Namespace access URLs\n- Environment: dev\n- Namespace: dev\n- B2B base URL: https://B2B.example.invalid/';
  assert.deepEqual(parseNamespaceUrls(partial), { namespace: 'dev', environment: 'DEV', links: [
    { kind: 'b2b-base', label: 'B2B base', url: 'https://b2b.example.invalid/' },
  ] });
});

test('requires complete identifying metadata and a known URL under the summary heading', () => {
  for (const text of [null, {}, '', summary.replace('# Namespace access URLs\n', ''),
    summary.replace('- Environment: `DEV`\n', ''), summary.replace('- Namespace: `feature-123`\n', ''),
    '# Namespace access URLs\n- Environment: DEV\n- Namespace: feature-123',
    summary.replace(/- B2[CB].* URL:/g, '- Other URL:'),
    summary.replace('- B2C base URL:', '# Another summary\n- B2C base URL:')]) {
    assert.equal(parseNamespaceUrls(text), null, String(text));
  }
  assert.deepEqual(parseNamespaceUrls(`${summary}\n- Other URL: javascript:alert(1)`), parseNamespaceUrls(summary));
});

test('rejects a different environment or an invalid Kubernetes namespace', () => {
  for (const environment of ['TST', 'PRE', 'PRD', '', 'DEV-other', '`DEV', 'DEV`']) {
    assert.equal(parseNamespaceUrls(summary.replace('`DEV`', environment)), null, environment);
  }
  for (const namespace of ['', 'Feature-123', '-feature', 'feature-', 'feature.name', 'feature_name',
    'feature/name', 'feature name', 'a'.repeat(64), '`feature', 'feature`']) {
    assert.equal(parseNamespaceUrls(summary.replace('`feature-123`', namespace)), null, namespace);
  }
  assert.equal(parseNamespaceUrls(summary.replace('feature-123', 'a'.repeat(63))).namespace, 'a'.repeat(63));
  assert.equal(parseNamespaceUrls(summary.replace('feature-123', 'a')).namespace, 'a');
});

test('rejects unsafe or ambiguous URLs instead of allowing URL parser repairs', () => {
  for (const url of ['http://b2c.example.invalid', 'javascript:alert(1)', '//b2c.example.invalid',
    'https://user:secret@b2c.example.invalid', 'https://user@b2c.example.invalid', 'https://@b2c.example.invalid',
    'https://b2c.example.invalid/?token=secret', 'https://b2c.example.invalid/#secret',
    'https://b2c.example.invalid/?', 'https://b2c.example.invalid/#',
    'https://b2c.example.invalid\\other', 'https://b2c.exa\tmple.invalid',
    'https://b2c.example.invalid/with space', 'https://b2c.example.invalid/\u0000',
    'https://', 'https:////b2c.example.invalid', 'https://[invalid', '[Launch](https://b2c.example.invalid)', '<https://b2c.example.invalid>']) {
    assert.equal(parseNamespaceUrls(summary.replace('https://b2c.example.invalid\n', `${url}\n`)), null, JSON.stringify(url));
  }
});

test('identical repeated output is accepted but conflicting metadata and URLs fail closed', () => {
  const expected = parseNamespaceUrls(summary);
  assert.deepEqual(parseNamespaceUrls(`${summary}\n${summary}`), expected);
  assert.deepEqual(parseNamespaceUrls(`${summary}\n- B2C base URL: https://b2c.example.invalid/`), expected);
  for (const extra of ['- Namespace: another-namespace', '- Environment: TST',
    '- B2C base URL: https://other.example.invalid/',
    summary.replace('feature-123', 'another-namespace'),
    summary.replace('https://b2c.example.invalid\n', 'https://other.example.invalid\n'),
    '# Namespace access URLs\n- Environment: DEV\n- Namespace: feature-123']) {
    assert.equal(parseNamespaceUrls(`${summary}\n${extra}`), null, extra);
  }
});
