import { spawn, spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertStableFileIdentity,
  hashStableFileIdentity,
} from '../../scripts/llm/stable-file-identity'
import {
  createRuntimeAttestation,
  parseProcessStartTimeTicks,
  type RuntimeAttestationPayload,
} from '../../src/platform/llm/runtime/attestation'

const root = resolve(import.meta.dirname, '../..')
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  )
})

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

async function memoryFixture(
  meminfo: string,
): Promise<{ fixtureRoot: string; meminfoPath: string }> {
  const fixtureRoot = await temporaryDirectory('indigo-memory-control-')
  const lockDirectory = join(fixtureRoot, 'llm/models/qwen3.5-9b-q4_k_m')
  await mkdir(lockDirectory, { recursive: true })
  await writeFile(
    join(lockDirectory, 'artifact.lock.json'),
    `${JSON.stringify({ sizeBytes: 1024 })}\n`,
  )
  const meminfoPath = join(fixtureRoot, 'meminfo')
  await writeFile(meminfoPath, meminfo)
  return { fixtureRoot, meminfoPath }
}

function runMemoryGate(fixtureRoot: string, meminfoPath: string) {
  return spawnSync(
    'bash',
    [
      '-c',
      'source "$1"; indigo_assert_llm_model_load_memory "$2" "$3"',
      'runtime-memory-test',
      resolve(root, 'scripts/lib/llm-runtime.sh'),
      fixtureRoot,
      meminfoPath,
    ],
    { cwd: root, encoding: 'utf8' },
  )
}

function fakeAttestation(pid: number): RuntimeAttestationPayload {
  return {
    schemaVersion: 1,
    createdAt: '2026-07-13T00:00:00.000Z',
    pid,
    processStartTimeTicks: '1',
    endpoint: 'http://127.0.0.1:8080/v1',
    modelId: 'qwen3.5-9b-q4_k_m',
    servedModelName: 'qwen3.5-9b-q4_k_m',
    gpuLayers: -2,
    runtime: {
      repository: 'https://github.com/ggml-org/llama.cpp.git',
      commit: '99f3dc32296f825fec94f202da1e9fede1e78cf9',
      version: '1 (99f3dc3)',
      libraries: [
        {
          filename: 'libllama.so.0.0.1',
          realpath: '/invalid/libllama.so.0.0.1',
          device: '1',
          inode: '2',
          sizeBytes: 3,
          mtimeMs: 4,
          sha256: 'c'.repeat(64),
        },
      ],
      realpath: '/invalid/llama-server',
      device: '5',
      inode: '6',
      sizeBytes: 7,
      mtimeMs: 8,
      sha256: 'a'.repeat(64),
    },
    weights: {
      realpath: '/invalid/qwen.gguf',
      device: '9',
      inode: '10',
      sizeBytes: 11,
      mtimeMs: 12,
      sha256: 'b'.repeat(64),
    },
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function killTestProcess(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // The exact-identity test intentionally terminates its process first.
  }
}

describe('LLM runtime executable controls', () => {
  it('fails closed when MemAvailable is below artifact bytes plus 4 GiB', async () => {
    const fixture = await memoryFixture('MemAvailable: 4194304 kB\n')
    const result = runMemoryGate(fixture.fixtureRoot, fixture.meminfoPath)

    expect(result.status).toBe(2)
    expect(result.stderr).toContain(
      'model start requires artifact bytes + 4 GiB RAM headroom',
    )
  })

  it.each([
    'MemAvailable: nope kB\n',
    'MemTotal: 8192 kB\n',
  ])('fails closed for malformed meminfo: %s', async (meminfo) => {
    const fixture = await memoryFixture(meminfo)
    const result = runMemoryGate(fixture.fixtureRoot, fixture.meminfoPath)

    expect(result.status).toBe(2)
    expect(result.stderr).toMatch(/invalid MemAvailable|does not report MemAvailable/)
  })

  it('retains the lifecycle lock for a live child and releases it after exit', async () => {
    const directory = await temporaryDirectory('indigo-lifecycle-control-')
    const lockPath = join(directory, 'lifecycle.lock')
    const script = `
      set -euo pipefail
      source "$1"
      exec 9>"$2"
      flock -n 9
      sleep 30 &
      launcher_pid=$!
      (indigo_hold_llm_lifecycle_lock_until_exit "$launcher_pid" 9) &
      watcher_pid=$!
      trap 'kill "$launcher_pid" "$watcher_pid" 2>/dev/null || true' EXIT
      sleep 0.1
      exec 8>"$2"
      if flock -n 8; then exit 41; fi
      kill "$launcher_pid"
      wait "$launcher_pid" 2>/dev/null || true
      wait "$watcher_pid"
      flock -n 8
    `
    const result = spawnSync(
      'bash',
      [
        '-c',
        script,
        'runtime-lifecycle-test',
        resolve(root, 'scripts/lib/llm-runtime.sh'),
        lockPath,
      ],
      { cwd: root, encoding: 'utf8', timeout: 5_000 },
    )

    expect(result.status).toBe(0)
  })

  it('rejects wrong and unlocked inherited lifecycle descriptors before GPU work', async () => {
    const directory = await temporaryDirectory('indigo-unlocked-control-')
    const lockPath = join(directory, 'lifecycle.lock')
    const wrongDescriptor = spawnSync(
      'bash',
      ['scripts/llm/serve-local.sh', '--check-inherited-lifecycle-lock', lockPath],
      {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, INDIGO_LLM_LIFECYCLE_LOCK_FD: '8' },
      },
    )
    expect(wrongDescriptor.status).toBe(2)
    expect(wrongDescriptor.stderr).toContain('inherited LLM lifecycle lock must use fd 9')
    expect(`${wrongDescriptor.stdout}${wrongDescriptor.stderr}`).not.toContain('GPU OK')

    const unlockedDescriptor = spawnSync(
      'bash',
      [
        '-c',
        'exec 9>"$1"; INDIGO_LLM_LIFECYCLE_LOCK_FD=9 bash scripts/llm/serve-local.sh --check-inherited-lifecycle-lock "$1"',
        'runtime-unlocked-test',
        lockPath,
      ],
      { cwd: root, encoding: 'utf8' },
    )
    expect(unlockedDescriptor.status).toBe(2)
    expect(unlockedDescriptor.stderr).toContain(
      'inherited LLM lifecycle fd is not locked',
    )
    expect(`${unlockedDescriptor.stdout}${unlockedDescriptor.stderr}`).not.toContain(
      'GPU OK',
    )

    const competingDescriptor = spawnSync(
      'bash',
      [
        '-c',
        'exec 8>"$1"; flock -n 8; exec 9>"$1"; INDIGO_LLM_LIFECYCLE_LOCK_FD=9 bash scripts/llm/serve-local.sh --check-inherited-lifecycle-lock "$1"',
        'runtime-competing-lock-test',
        lockPath,
      ],
      { cwd: root, encoding: 'utf8' },
    )
    expect(competingDescriptor.status).toBe(2)
    expect(competingDescriptor.stderr).toContain(
      'inherited LLM lifecycle fd does not own the active lock',
    )

    const lockedDescriptor = spawnSync(
      'bash',
      [
        '-c',
        'exec 9>"$1"; flock -n 9; INDIGO_LLM_LIFECYCLE_LOCK_FD=9 bash scripts/llm/serve-local.sh --check-inherited-lifecycle-lock "$1"',
        'runtime-owned-lock-test',
        lockPath,
      ],
      { cwd: root, encoding: 'utf8' },
    )
    expect(lockedDescriptor.status).toBe(0)
    expect(lockedDescriptor.stdout).toContain('Inherited LLM lifecycle lock is valid')
  })

  it('refuses a listener/attestation PID mismatch without signaling the listener PID', async () => {
    const directory = await temporaryDirectory('indigo-stop-control-')
    const attestationPath = join(directory, 'attestation.json')
    const listener = spawn('sleep', ['30'], { stdio: 'ignore' })
    if (!listener.pid) throw new Error('test listener did not start')

    try {
      await writeFile(
        attestationPath,
        `${JSON.stringify(createRuntimeAttestation(fakeAttestation(listener.pid + 1)))}\n`,
        { mode: 0o600 },
      )
      await chmod(attestationPath, 0o600)
      const result = spawnSync(
        'node',
        [
          '--import',
          'tsx',
          'scripts/llm/stop-attested-runtime.ts',
          '--root',
          root,
          '--attestation',
          attestationPath,
          '--listener-pid',
          String(listener.pid),
        ],
        { cwd: root, encoding: 'utf8' },
      )

      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain(
        `listener PID ${listener.pid} is not attested PID ${listener.pid + 1}`,
      )
      expect(listener.exitCode).toBeNull()
      process.kill(listener.pid, 0)
    } finally {
      listener.kill('SIGTERM')
    }
  })

  it('signals the exact pidfd process identity', async () => {
    const target = spawn('sleep', ['30'], { stdio: 'ignore' })
    if (!target.pid) throw new Error('pidfd test target did not start')
    const targetPid = target.pid

    try {
      const startTimeTicks = parseProcessStartTimeTicks(
        await readFile(`/proc/${targetPid}/stat`, 'utf8'),
      )
      const result = spawnSync(
        'python3',
        ['scripts/llm/pidfd-signal.py', String(targetPid), startTimeTicks],
        { cwd: root, encoding: 'utf8' },
      )

      expect(result.status).toBe(0)
      await expect.poll(() => processIsAlive(targetPid)).toBe(false)
    } finally {
      killTestProcess(targetPid)
    }
  })

  it('rejects a stale pidfd start time without signaling the live process', async () => {
    const target = spawn('sleep', ['30'], { stdio: 'ignore' })
    if (!target.pid) throw new Error('pidfd mismatch target did not start')
    const targetPid = target.pid

    try {
      const startTimeTicks = parseProcessStartTimeTicks(
        await readFile(`/proc/${targetPid}/stat`, 'utf8'),
      )
      const wrongStartTimeTicks = (BigInt(startTimeTicks) + 1n).toString(10)
      const result = spawnSync(
        'python3',
        ['scripts/llm/pidfd-signal.py', String(targetPid), wrongStartTimeTicks],
        { cwd: root, encoding: 'utf8' },
      )

      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('process identity changed before shutdown signal')
      expect(processIsAlive(targetPid)).toBe(true)
    } finally {
      killTestProcess(targetPid)
    }
  })

  it('rejects a path replacement between stable hashing and final verification', async () => {
    const directory = await temporaryDirectory('indigo-file-identity-control-')
    const path = join(directory, 'llama-server')
    const replacedPath = join(directory, 'llama-server.hashed')
    await writeFile(path, 'same locked bytes')
    const identity = await hashStableFileIdentity(path, 'Test runtime binary')

    await rename(path, replacedPath)
    await writeFile(path, 'same locked bytes')

    await expect(
      assertStableFileIdentity(path, identity, 'Test runtime binary'),
    ).rejects.toThrow(
      'Test runtime binary path no longer identifies the file that was hashed',
    )
  })
})
