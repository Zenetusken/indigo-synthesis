import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const projectRoot = process.cwd()
const archiveScript = resolve(projectRoot, 'scripts/llm/archive-product-path.sh')
const sourceCommit = '1111111111111111111111111111111111111111'
const sourceTree = '2222222222222222222222222222222222222222'
const driftCommit = '3333333333333333333333333333333333333333'
const driftTree = '4444444444444444444444444444444444444444'
const tempRoots: string[] = []

function executable(path: string, contents: string) {
  writeFileSync(path, contents)
  chmodSync(path, 0o755)
}

function runArchive(
  options: {
    dirty?: boolean
    driftAfterE2e?: boolean
    e2eExitCode?: number
    preflightNotReady?: boolean
    runtimeDrift?: boolean
  } = {},
) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'indigo-llm-archive-test-'))
  tempRoots.push(fixtureRoot)
  const bin = join(fixtureRoot, 'bin')
  const archiveDir = join(fixtureRoot, 'archive')
  const driftFlag = join(fixtureRoot, 'source-drifted')
  const nodeLog = join(fixtureRoot, 'node-calls.log')
  const preflightCount = join(fixtureRoot, 'preflight-count')
  mkdirSync(bin)

  executable(
    join(bin, 'git'),
    `#!/usr/bin/env bash
set -euo pipefail
case "\${1:-}" in
  rev-parse)
    if [[ "\${2:-}" == "--show-toplevel" ]]; then
      printf '%s\\n' "$GIT_FAKE_ROOT"
    elif [[ "\${2:-}" == "--verify" && "\${3:-}" == "HEAD^{commit}" ]]; then
      if [[ -f "$GIT_DRIFT_FLAG" ]]; then
        printf '%s\\n' "$GIT_DRIFT_COMMIT"
      else
        printf '%s\\n' "$GIT_SOURCE_COMMIT"
      fi
    elif [[ "\${2:-}" == "--verify" && "\${3:-}" == *"^{tree}" ]]; then
      if [[ "\${3:-}" == "$GIT_DRIFT_COMMIT"* ]]; then
        printf '%s\\n' "$GIT_DRIFT_TREE"
      else
        printf '%s\\n' "$GIT_SOURCE_TREE"
      fi
    else
      exit 64
    fi
    ;;
  status)
    if [[ "\${GIT_DIRTY:-0}" == "1" ]]; then
      printf ' M src/platform/llm/example.ts\\n?? scratch.ts\\n'
    fi
    ;;
  *) exit 64 ;;
esac
`,
  )
  executable(
    join(bin, 'node'),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$STUB_NODE_LOG"
if [[ "$*" == *"scripts/llm/preflight.ts"* ]]; then
  generation=1
  if [[ "\${STUB_RUNTIME_DRIFT:-0}" == "1" ]]; then
    count=0
    if [[ -f "$STUB_PREFLIGHT_COUNT" ]]; then
      count="$(<"$STUB_PREFLIGHT_COUNT")"
    fi
    count=$((count + 1))
    printf '%s\\n' "$count" > "$STUB_PREFLIGHT_COUNT"
    generation=$(((count + 1) / 2))
  fi
  if [[ "\${STUB_PREFLIGHT_NOT_READY:-0}" == "1" ]]; then
    printf '{"readyForLocalInference":false,"runtimeEvidence":{"state":"invalid"},"blockers":["stub blocker"],"verifiedRuntimeIdentity":{"runtimeId":"runtime:test:%s","runtimeAttestationDigest":"attestation-test-%s"}}\\n' "$generation" "$generation"
  else
    printf '{"readyForLocalInference":true,"runtimeEvidence":{"state":"verified"},"blockers":[],"verifiedRuntimeIdentity":{"runtimeId":"runtime:test:%s","runtimeAttestationDigest":"attestation-test-%s"}}\\n' "$generation" "$generation"
  fi
elif [[ "$*" == *"scripts/llm/validate-baseline.ts"* ]]; then
  printf '%s\\n' '{"baselineVersion":"test-v1","offline":{"ok":true},"live":{"availableRate":1.0,"latencyMs":{"p50":80,"p95":100}}}'
else
  exit 64
fi
`,
  )
  executable(
    join(bin, 'pnpm'),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" != "test:e2e:llm" ]]; then
  exit 64
fi
if [[ "\${STUB_TRIGGER_DRIFT:-0}" == "1" ]]; then
  : > "$GIT_DRIFT_FLAG"
fi
printf '%s\\n' 'stubbed live E2E'
exit "\${STUB_E2E_EXIT_CODE:-0}"
`,
  )
  executable(
    join(bin, 'flock'),
    `#!/usr/bin/env bash
exit 0
`,
  )

  const result = spawnSync('bash', [archiveScript], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      RUNS: '3',
      INDIGO_LLM_ARCHIVE_DIR: archiveDir,
      GIT_FAKE_ROOT: projectRoot,
      GIT_SOURCE_COMMIT: sourceCommit,
      GIT_SOURCE_TREE: sourceTree,
      GIT_DRIFT_COMMIT: driftCommit,
      GIT_DRIFT_TREE: driftTree,
      GIT_DRIFT_FLAG: driftFlag,
      GIT_DIRTY: options.dirty ? '1' : '0',
      STUB_TRIGGER_DRIFT: options.driftAfterE2e ? '1' : '0',
      STUB_E2E_EXIT_CODE: String(options.e2eExitCode ?? 0),
      STUB_PREFLIGHT_NOT_READY: options.preflightNotReady ? '1' : '0',
      STUB_RUNTIME_DRIFT: options.runtimeDrift ? '1' : '0',
      STUB_PREFLIGHT_COUNT: preflightCount,
      STUB_NODE_LOG: nodeLog,
    },
  })

  return { archiveDir, nodeLog, result }
}

afterEach(() => {
  for (const path of tempRoots.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

describe('LLM product-path archive source provenance', () => {
  it('records one clean commit and tree in every run and the verified batch manifest', () => {
    const { archiveDir, result } = runArchive()

    expect(result.status, result.stderr).toBe(0)
    const files = readdirSync(archiveDir)
    const runFiles = files.filter((file) => /^product-path-.*-r\d+\.json$/.test(file))
    const perRunJsonFiles = files.filter((file) => /^product-path-.*\.json$/.test(file))
    const manifestFile = files.find((file) => /^archive-batch-.*\.json$/.test(file))

    expect(runFiles).toHaveLength(3)
    expect(perRunJsonFiles).toHaveLength(12)
    expect(manifestFile).toBeDefined()
    for (const file of perRunJsonFiles) {
      const row = JSON.parse(readFileSync(join(archiveDir, file), 'utf8')) as {
        archiveSource: Record<string, unknown>
      }
      expect(row.archiveSource).toMatchObject({
        commit: sourceCommit,
        tree: sourceTree,
        worktree: 'clean',
      })
    }
    for (const file of runFiles) {
      const row = JSON.parse(readFileSync(join(archiveDir, file), 'utf8')) as {
        archive: Record<string, unknown>
      }
      expect(row.archive).toMatchObject({
        status: 'verified',
        sourceCommit,
        sourceTree,
        sourceWorktree: 'clean',
      })
    }

    const manifest = JSON.parse(
      readFileSync(join(archiveDir, manifestFile as string), 'utf8'),
    ) as {
      status: string
      source: Record<string, unknown>
      summary: Record<string, unknown>
      runs: Array<Record<string, unknown>>
    }
    expect(manifest).toMatchObject({
      status: 'verified',
      source: { commit: sourceCommit, tree: sourceTree, worktree: 'clean' },
      summary: { runCount: 3, allProductE2ePassed: true },
    })
    expect(manifest.runs).toHaveLength(3)
    expect(
      manifest.runs.every(
        (run) => run.sourceCommit === sourceCommit && run.sourceTree === sourceTree,
      ),
    ).toBe(true)
  })

  it('refuses dirty tracked or untracked source before invoking runtime checks', () => {
    const { archiveDir, nodeLog, result } = runArchive({ dirty: true })

    expect(result.status).toBe(2)
    expect(result.stderr).toContain(
      'calibrated archives require a clean tracked and untracked worktree',
    )
    expect(result.stderr).toContain('?? scratch.ts')
    expect(existsSync(archiveDir)).toBe(false)
    expect(existsSync(nodeLog)).toBe(false)
  })

  it('rejects a commit or tree change during a run without publishing a batch', () => {
    const { archiveDir, result } = runArchive({ driftAfterE2e: true })

    expect(result.status).toBe(2)
    expect(result.stderr).toContain('source identity changed during archive')
    expect(readdirSync(archiveDir)).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^archive-batch-.*\.json$/)]),
    )
  })

  it('does not publish verified run or batch JSON after a failed product gate', () => {
    const { archiveDir, result } = runArchive({ e2eExitCode: 1 })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('e2e failed; see')
    const files = readdirSync(archiveDir)
    expect(files.some((file) => /^product-path-.*-r\d+\.json$/.test(file))).toBe(false)
    expect(files.some((file) => /^archive-batch-.*\.json$/.test(file))).toBe(false)
  })

  it('rejects a zero-exit preflight report that is not ready and verified', () => {
    const { archiveDir, result } = runArchive({ preflightNotReady: true })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('runtime preflight before run is not ready')
    const files = readdirSync(archiveDir)
    expect(files.some((file) => /^product-path-.*-r\d+\.json$/.test(file))).toBe(false)
    expect(files.some((file) => /^archive-batch-.*\.json$/.test(file))).toBe(false)
  })

  it('withholds the batch manifest when individually valid runs have identity drift', () => {
    const { archiveDir, result } = runArchive({ runtimeDrift: true })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('archive identity drifted across runs')
    const files = readdirSync(archiveDir)
    expect(
      files.filter((file) => /^product-path-.*-r\d+\.json$/.test(file)),
    ).toHaveLength(3)
    expect(files.some((file) => /^archive-batch-.*\.json$/.test(file))).toBe(false)
  })
})
