import assert from 'node:assert/strict'
import { test } from 'node:test'

import { checkInstallLocation, humanUsers } from '../core/installLocation.js'

const PASSWD = [
  'root:x:0:0:root:/root:/bin/bash',
  'daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin',
  'alex:x:1000:1000:Alex:/home/alex:/bin/bash',
  'svc:x:1001:1001::/home/svc:/bin/bash',
  'runner:x:1002:1002::/home/runner:/usr/sbin/nologin',
  'nobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin',
].join('\n')
const shared = humanUsers(PASSWD)
const one = humanUsers(PASSWD.split('\n').filter((l) => !l.startsWith('svc')).join('\n'))

test('human users are login accounts from uid 1000, not services or nobody', () => {
  assert.deepEqual(shared.map((u) => u.name), ['alex', 'svc'])
})

test('a checkout in a home is refused only when another account runs Cortex too, and the refusal says what to do', () => {
  const sharing = shared.map((u) => ({ ...u, cortex: true }))
  const r = checkInstallLocation({ platform: 'linux', repoRoot: '/home/alex/cortex-v2', home: '/home/alex', users: sharing, singleUser: false })
  assert.equal(r.ok, false)
  assert.match((r as { reason: string }).reason, /svc also runs Cortex.*shared checkout.*--single-user/)
})

test('other accounts that do not run Cortex (a container image\'s node user) do not block a one-person install', () => {
  const r = checkInstallLocation({ platform: 'linux', repoRoot: '/home/alex/cortex', home: '/home/alex', users: [{ name: 'node', uid: 1000, home: '/home/node' }, { name: 'alex', uid: 1001, home: '/home/alex' }], singleUser: false })
  assert.equal(r.ok, true)
  assert.match((r as { note: string }).note, /other accounts here \(node\) do not run Cortex/)
})

test('a shared checkout, a single-user machine, --single-user, and non-Linux all pass', () => {
  const sharing = shared.map((u) => ({ ...u, cortex: true }))
  assert.equal(checkInstallLocation({ platform: 'linux', repoRoot: '/srv/cortex/cortex-v2-deploy', home: '/home/alex', users: sharing, singleUser: false }).ok, true)
  assert.equal(checkInstallLocation({ platform: 'linux', repoRoot: '/home/alex/cortex-v2', home: '/home/alex', users: one, singleUser: false }).ok, true)
  assert.equal(checkInstallLocation({ platform: 'linux', repoRoot: '/home/alex/cortex-v2', home: '/home/alex', users: sharing, singleUser: true }).ok, true)
  assert.equal(checkInstallLocation({ platform: 'darwin', repoRoot: '/Users/c/cortex-v2', home: '/Users/c', users: sharing, singleUser: false }).ok, true)
})
