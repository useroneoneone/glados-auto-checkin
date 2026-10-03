import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { spawnSync } from 'node:child_process'

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'glados-installer-test-'))
  const bin = join(directory, 'bin')
  const target = join(directory, 'target')
  mkdirSync(bin)
  mkdirSync(target)
  const docker = join(bin, 'docker')
  writeFileSync(docker, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$DOCKER_TEST_LOG"\n')
  chmodSync(docker, 0o755)
  const openssl = join(bin, 'openssl')
  writeFileSync(openssl, '#!/bin/sh\n[ "$*" = "rand -hex 32" ] || exit 1\nprintf "%064d\\n" 0\n')
  chmodSync(openssl, 0o755)
  const bundle = join(directory, 'bundle')
  mkdirSync(bundle)
  writeFileSync(join(bundle, 'install.sh'), readFileSync(new URL('../scripts/install.sh', import.meta.url), 'utf8'))
  writeFileSync(join(bundle, 'compose.yaml'), 'services: {}\n')
  const log = join(directory, 'docker.log')
  const run = (password = '') => spawnSync('bash', [join(bundle, 'install.sh'), target], {
    encoding: 'utf8', env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, DOCKER_TEST_LOG: log, GLADOS_ADMIN_PASSWORD: password },
  })
  return { target, log, run }
}

test('installer generates new secrets without printing them and pulls a prebuilt image', { skip: process.platform === 'win32' }, () => {
  const f = setup()
  const result = f.run('fixture-password-12345')
  assert.equal(result.status, 0, result.stderr)
  const env = readFileSync(join(f.target, '.env'), 'utf8')
  assert.match(env, /^ADMIN_PASSWORD=fixture-password-12345$/m)
  assert.match(env, /^APP_SECRET=[a-f0-9]{64}$/m)
  assert.match(env, /^SESSION_SECRET=[a-f0-9]{64}$/m)
  assert.doesNotMatch(result.stdout + result.stderr, /fixture-password-12345|APP_SECRET=|SESSION_SECRET=/)
  const log = readFileSync(f.log, 'utf8')
  assert.match(log, /compose -f compose.yaml pull/)
  assert.match(log, /compose -f compose.yaml up -d/)
  assert.doesNotMatch(log, /build|down|volume rm/)
})

test('installer preserves existing environment, compose configuration and database', { skip: process.platform === 'win32' }, () => {
  const f = setup()
  const env = 'APP_SECRET=fixture-existing-secret\nGLADOS_IMAGE=fixture-image\n'
  writeFileSync(join(f.target, '.env'), env)
  writeFileSync(join(f.target, 'compose.yaml'), 'fixture-existing-compose\n')
  mkdirSync(join(f.target, 'data'))
  writeFileSync(join(f.target, 'data/glados.sqlite'), 'fixture-database')
  const result = f.run()
  assert.equal(result.status, 0, result.stderr)
  assert.equal(readFileSync(join(f.target, '.env'), 'utf8'), env)
  assert.equal(readFileSync(join(f.target, 'compose.yaml'), 'utf8'), 'fixture-existing-compose\n')
  assert.equal(readFileSync(join(f.target, 'data/glados.sqlite'), 'utf8'), 'fixture-database')
})

test('installer rejects weak/default passwords before creating environment or pulling', { skip: process.platform === 'win32' }, () => {
  for (const password of ['short', 'change-this-password', 'spaces are rejected']) {
    const f = setup()
    const result = f.run(password)
    assert.notEqual(result.status, 0)
    assert.equal(existsSync(join(f.target, '.env')), false)
    assert.doesNotMatch(readFileSync(f.log, 'utf8'), / pull| up /)
  }
})
