import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { buildDeploymentPackage } from '../scripts/package-release.mjs'

const commit = '0123456789abcdef0123456789abcdef01234567'

test('deployment bundle pins an image, includes checksums and excludes runtime data', () => {
  const output = mkdtempSync(join(tmpdir(), 'glados-release-test-'))
  const result = buildDeploymentPackage({ version: 'v1.1.0', commit, output })
  const root = 'glados-auto-checkin-v1.1.0-deploy'
  const entries = execFileSync('tar', ['-tzf', result.archive], { encoding: 'utf8' }).trim().split(/\r?\n/)
  assert.deepEqual(entries.filter((entry) => !entry.endsWith('/')).sort(), [
    '.env.example', 'INSTALL.zh-CN.md', 'compose.yaml', 'install.sh', 'release.json',
  ].map((name) => `${root}/${name}`).sort())
  const extract = (name) => execFileSync('tar', ['-xOzf', result.archive, `${root}/${name}`], { encoding: 'utf8' })
  assert.match(extract('compose.yaml'), /ghcr\.io\/useroneoneone\/glados-auto-checkin:sha-0123456789ab/)
  assert.match(extract('.env.example'), /ADMIN_PASSWORD=change-this-password/)
  assert.equal(JSON.parse(extract('release.json')).commit, commit)
  assert.doesNotMatch(extract('install.sh'), /\r/)
  assert.match(extract('install.sh'), /if \[\[ ! -f .*\.env.*\]\]/)
  const digest = createHash('sha256').update(readFileSync(result.archive)).digest('hex')
  assert.equal(readFileSync(result.checksums, 'utf8'), `${digest}  ${root}.tar.gz\n`)
})

test('release metadata rejects ambiguous versions, revisions and unsafe paths', () => {
  for (const version of ['latest', '../v1.0.0', 'v1.1.0\nunsafe']) {
    assert.throws(() => buildDeploymentPackage({ version, commit }), /version/)
  }
  assert.throws(() => buildDeploymentPackage({ version: 'v1.1.0', commit: 'HEAD' }), /commit/)
})
