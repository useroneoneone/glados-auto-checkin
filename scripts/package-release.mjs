import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export function buildDeploymentPackage({ version, commit, output = join(project, '.local-release') }) {
  if (!/^v\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version || '')) throw new Error('An explicit vMAJOR.MINOR.PATCH version is required')
  if (!/^[a-f0-9]{40}$/.test(commit || '')) throw new Error('An explicit 40-character commit SHA is required')
  output = resolve(output)
  mkdirSync(output, { recursive: true })
  const name = `glados-auto-checkin-${version}-deploy`
  const archive = join(output, `${name}.tar.gz`)
  const checksums = join(output, 'SHA256SUMS')
  if (existsSync(archive)) throw new Error(`Archive already exists: ${archive}`)
  const staging = mkdtempSync(join(output, '.staging-'))
  const bundle = join(staging, name)
  mkdirSync(bundle)
  const image = `ghcr.io/useroneoneone/glados-auto-checkin:sha-${commit.slice(0, 12)}`
  const compose = readFileSync(join(project, 'docker-compose.prod.yml'), 'utf8').replace(
    'ghcr.io/useroneoneone/glados-auto-checkin:latest', image,
  ).replace(/\r\n/g, '\n')
  if (!compose.includes(image)) throw new Error('Production Compose image default was not found')
  writeFileSync(join(bundle, 'compose.yaml'), compose)
  copyFileSync(join(project, '.env.example'), join(bundle, '.env.example'))
  copyFileSync(join(project, 'docs/INSTALL.zh-CN.md'), join(bundle, 'INSTALL.zh-CN.md'))
  writeFileSync(join(bundle, 'install.sh'), readFileSync(join(project, 'scripts/install.sh'), 'utf8').replace(/\r\n/g, '\n'))
  chmodSync(join(bundle, 'install.sh'), 0o755)
  writeFileSync(join(bundle, 'release.json'), `${JSON.stringify({ version, commit, image, platform: 'linux/amd64' }, null, 2)}\n`)
  execFileSync('tar', ['-czf', archive, '-C', staging, name], { stdio: 'pipe' })
  const digest = createHash('sha256').update(readFileSync(archive)).digest('hex')
  writeFileSync(checksums, `${digest}  ${name}.tar.gz\n`)
  return { archive, checksums, image, digest }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [version, commit, output] = process.argv.slice(2)
  console.log(JSON.stringify(buildDeploymentPackage({ version, commit, output }), null, 2))
}
