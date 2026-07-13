import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const runnerPath = resolve(root, 'scripts/e2e/run-network-denied.sh')
const runner = readFileSync(runnerPath, 'utf8')
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
  readonly scripts: Readonly<Record<string, string>>
}

describe('outbound-network-denied E2E runner', () => {
  it('uses a user-owned network namespace with only loopback', () => {
    expect(runner).toContain('unshare --user --map-root-user --net')
    expect(runner).toContain('ip link set lo up')
    expect(runner).toContain('ip -4 route show default')
    expect(runner).toContain('ip -6 route show default')
    expect(runner).toContain("host: '1.1.1.1', port: 443")
    expect(runner).not.toMatch(/\b(?:sudo|iptables|nft)\b/)
  })

  it('exposes only the guarded loopback PostgreSQL endpoint through the namespace', () => {
    expect(runner).toContain('DATABASE_URL and E2E_DATABASE_URL must share')
    expect(runner).toContain(`UNIX-LISTEN:\${bridge_socket}`)
    expect(runner).toContain(`UNIX-CONNECT:\${INDIGO_NETWORK_DENIED_DB_SOCKET}`)
    expect(runner).toContain('bash scripts/e2e/run.sh default')
  })

  it('remains an explicit release-evidence command', () => {
    expect(Object.values(packageJson.scripts).join('\n')).not.toContain(
      'run-network-denied.sh',
    )
  })
})
