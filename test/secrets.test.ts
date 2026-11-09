import assert from 'node:assert/strict'
import test from 'node:test'

import { hasSecrets, scanForSecrets } from '../core/secrets.js'

// ── the false-positive guard, which matters most on THIS fleet ───────────────

test('a memory that DISCUSSES the secrets system by name is not quarantined', () => {
  // The failure this guards: a name-matching scanner quarantines the
  // documentation of a secrets system while the actual secrets flow past it.
  // These are real sentences from this corpus.
  const prose = [
    'All env vars and secrets come from OpenBao through the bao-run wrapper at the launcher boundary.',
    'Bootstrap creds BAO_ADDR, BAO_ROLE_ID and BAO_SECRET_ID live in ~/.claude/.env, chmod 600.',
    'Add it to OpenBao with kv patch, not put, and wrap the consumer in bao-run.',
    'Set ANTHROPIC_API_KEY in the launcher, never in a committed file.',
    'Usage: bao-run KEY1 KEY2 -- cmd args',
  ].join('\n')

  assert.deepEqual(scanForSecrets(prose), [], 'names are not values')
})

test('placeholders and shell forms are how prose talks about a secret', () => {
  const prose = [
    'export ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}',
    'token: <your-token-here>',
    'password: xxxxxxxxxxxx',
    'BAO_SECRET_ID=$(bao read -field=secret_id ...)',
  ].join('\n')

  assert.deepEqual(scanForSecrets(prose), [])
})

test('git shas and paths are not credentials', () => {
  const prose = [
    'Fixed in 6843a67 and verified against 7eca0fc.',
    'The pointer lives at /home/alex/.config/ckn/home and targets /mnt/data/Projects/personal.',
  ].join('\n')

  assert.deepEqual(scanForSecrets(prose), [])
})

// ── the values that must be caught ───────────────────────────────────────────

test('known credential prefixes are caught', () => {
  for (const v of [
    'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    'ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    'AKIAQ3EGUZ7XKZJ4M2PL', // synthetic: AWS's own example key is documentation (see below)
    'glpat-AAAAAAAAAAAAAAAAAAAA',
  ]) {
    assert.ok(hasSecrets(`The value is ${v} and it should never land.`), v.slice(0, 6))
  }
})

test('private key armour and JWTs are caught', () => {
  assert.ok(hasSecrets('-----BEGIN OPENSSH PRIVATE KEY-----'))
  assert.ok(
    hasSecrets('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NX0.dBjftJeZ4CVPmB92K'),
  )
})

test('a long high-entropy value is caught even with no recognisable prefix', () => {
  assert.ok(hasSecrets('token = aB3xQ7zR9mK2pL5vN8tW1yU4sD6fG0hJ'))
})

// ── URLs: the V1 exclusion that had to be re-derived ─────────────────────────

test('a connection string with an embedded password is quarantined', () => {
  // V1 excluded http(s):// wholesale, tuned for MCP configs where a URL is an
  // endpoint. In prose a URL is exactly where a credential hides.
  const findings = scanForSecrets('DB is at postgres://svc:hunter2correct@db.internal:5432/app')
  assert.equal(findings.length, 1)
  assert.equal(findings[0]!.kind, 'url-credential')
  assert.match(findings[0]!.hint, /authority/)
})

test('a credential-shaped query parameter is quarantined', () => {
  assert.ok(hasSecrets('Call https://api.example.com/v1/items?api_key=ZmFrZUtleVZhbHVl&page=2'))
  assert.ok(hasSecrets('Signed: https://cdn.example.com/f.zip?signature=abc123def456'))
})

test('a bare docs URL is NOT quarantined', () => {
  // The false-positive half of the same rule. A noisy quarantine stops being
  // read, and then real secrets sit unsynced in scratchpads.
  const prose = [
    'See https://docs.anthropic.com/en/docs/claude-code/hooks for the event list.',
    'Dashboard: http://10.0.0.12:3000/d/abc123/cortex?orgId=1&refresh=30s',
    'Repo at https://example.com/owner/cortex/-/blob/main/server/graph/sync.ts#L957',
  ].join('\n')

  assert.deepEqual(scanForSecrets(prose), [])
})

test('an opaque URL path does not trip the entropy pass', () => {
  // The URL is exempt AS A WHOLE from entropy scoring; only its
  // credential-bearing positions are scanned. Without that, every long
  // documentation link would quarantine.
  assert.deepEqual(
    scanForSecrets('https://example.com/aB3xQ7zR9mK2pL5vN8tW1yU4sD6fG0hJ/page.html'),
    [],
  )
})

// ── findings must not leak what they found ───────────────────────────────────

test('a finding never quotes the value it found', () => {
  // A finding travels into logs and status output. One that quoted the secret
  // would be the leak it exists to prevent, one layer over.
  const secret = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
  const findings = scanForSecrets(`key = ${secret}`)
  assert.ok(findings.length > 0)
  for (const f of findings) {
    assert.ok(!JSON.stringify(f).includes(secret), 'the finding is non-revealing')
  }
})

// ── names glued from short pieces are not values (laptop corpus, 2026-10-13) ─

test('slugs, timestamps and glued identifiers are not credentials', () => {
  // The shapes that quarantined 17% of a real corpus. Long and mixed-case only
  // because short pieces are joined; no single run is credential-length.
  const names = [
    'See precompact-5cd9b882-2026-10-13T12-30-37-732Z for the checkpoint.',
    'Captured in session_2026-10-13T12:30:37_2026-10-13T12:31:02.json yesterday.',
    'The handler is Some_CamelCase_Module_file9.ts and it owns the queue.',
    'Run it as sk.learn.Pipeline-step2-VERSION4 in the notebook.',
  ]
  for (const line of names) assert.deepEqual(scanForSecrets(line), [], line)
})

test('a bare provider prefix is a memory ABOUT a token type, not a token', () => {
  for (const line of [
    'GitLab PATs start with glpat- and fine-grained GitHub ones with github_pat_.',
    'The npm_ prefix marks an npm automation token; sk- marks an OpenAI key.',
    'Short ids like npm_config or sk-learn are not credentials.',
  ]) assert.deepEqual(scanForSecrets(line), [], line)
})

test('a credential-length run is still caught when joiners surround it', () => {
  const run = 'Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9'
  assert.equal(scanForSecrets(`label-${run}-suffix`)[0]?.kind, 'high-entropy')
  assert.equal(scanForSecrets(`glpat-${'x1Y2z3W4v5U6t7S8r9Q0'}`)[0]?.kind, 'provider-prefix')
})

test('a URL whose password is a <placeholder> is prose about a credential, not one (28 Oct)', () => {
  // The URL parser percent-encodes the brackets; the placeholder is judged as written.
  assert.equal(hasSecrets('Connect with postgresql://<user>:<pw>@db.internal:5432/globex; the password is in OpenBao.'), false)
  assert.equal(hasSecrets('postgresql://globex:Xk9pQ2rT7vLm4nB8@db/globex'), true, 'a real one still is')
})

test('text inside JSON (a sync bundle line, as the file gate reads it) is judged like the text itself', () => {
  const prose = 'The secret detector flags values.\nIt runs on every ingest and every bundle line.\nPlaceholders like <pw> are fine.'
  assert.deepEqual(scanForSecrets(JSON.stringify({ t: 'record', r: { content: prose } })), [], 'escaped newlines do not glue words into a high-entropy run')
  assert.equal(hasSecrets(JSON.stringify({ c: 'note\npostgresql://u:<pw>@h/db\nmore' })), false)
  assert.equal(hasSecrets(JSON.stringify({ c: 'note\nsk-ant-api03-PLANTEDsyntheticVALUE0123456789abcdef\nmore' })), true, 'a real key inside JSON is still caught')
})

test("explain gives a flagged token's shape, never the token, and only when asked", () => {
  const key = 'sk-ant-api03-PLANTEDsyntheticVALUE0123456789abcdef'
  assert.equal(scanForSecrets(`key ${key}`)[0]!.shape, undefined)
  const [f] = scanForSecrets(`key ${key}`, { explain: true })
  assert.equal(f!.shape, 'sk… 50 chars, a-z A-Z 0-9 other(-)')
  assert.ok(!JSON.stringify(f).includes(key.slice(2, 12)), 'nothing past the first two characters')
})

test("providers' published example keys are documentation, not credentials (28 Oct)", () => {
  assert.equal(hasSecrets('AWS documents AKIAIOSFODNN7EXAMPLE as its example access key id.'), false)
  assert.equal(hasSecrets('and wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY as the example secret'), false)
  assert.equal(hasSecrets(JSON.stringify({ c: 'rules skip\nAKIAIOSFODNN7EXAMPLE\nin tests' })), false, 'inside a bundle line too')
  assert.equal(hasSecrets('a real one: AKIAQ3EGUZ7XKZJ4M2PL'), true)
})
