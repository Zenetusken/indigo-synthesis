import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, resolve } from 'node:path'

function trackedMarkdownFiles(): readonly string[] {
  return execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '*.md'],
    { encoding: 'utf8' },
  )
    .split('\0')
    .filter(Boolean)
    .sort()
}

function githubHeadingSlug(heading: string): string {
  return heading
    .replace(/\[([^\]]+)]\([^)]+\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/[`*_~]/g, '')
    .toLocaleLowerCase('en-US')
    .trim()
    .replace(/[^\p{Letter}\p{Number}\-_ ]/gu, '')
    .replace(/\s/g, '-')
}

function headingAnchors(source: string): ReadonlySet<string> {
  const anchors = new Set<string>()
  const occurrences = new Map<string, number>()
  let fenced = false

  for (const line of source.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced
      continue
    }
    if (fenced) continue

    const heading = line.match(/^#{1,6}\s+(.+?)\s*#*$/)?.[1]
    if (!heading) continue
    const base = githubHeadingSlug(heading)
    const occurrence = occurrences.get(base) ?? 0
    occurrences.set(base, occurrence + 1)
    anchors.add(occurrence === 0 ? base : `${base}-${occurrence}`)
  }

  return anchors
}

const root = process.cwd()
const files = trackedMarkdownFiles()
const sourceByFile = new Map(
  files.map(
    (file) => [resolve(root, file), readFileSync(resolve(root, file), 'utf8')] as const,
  ),
)
const anchorsByFile = new Map<string, ReadonlySet<string>>()
const failures: string[] = []

for (const file of files) {
  const absoluteFile = resolve(root, file)
  const source = sourceByFile.get(absoluteFile) ?? ''

  for (const match of source.matchAll(/!?\[[^\]]*]\(([^)]+)\)/g)) {
    const rawTarget = match[1]?.trim().replace(/^<|>$/g, '') ?? ''
    if (!rawTarget || /^(?:https?:|mailto:)/.test(rawTarget)) continue

    const [encodedPath, encodedAnchor] = rawTarget.split('#', 2)
    const targetPath = decodeURIComponent(encodedPath ?? '')
    const anchor = decodeURIComponent(encodedAnchor ?? '')
    const absoluteTarget = targetPath
      ? resolve(dirname(absoluteFile), targetPath)
      : absoluteFile

    if (!existsSync(absoluteTarget)) {
      failures.push(`${file}: missing target ${rawTarget}`)
      continue
    }
    if (
      !anchor ||
      statSync(absoluteTarget).isDirectory() ||
      extname(absoluteTarget) !== '.md'
    ) {
      continue
    }

    const targetSource =
      sourceByFile.get(absoluteTarget) ?? readFileSync(absoluteTarget, 'utf8')
    let anchors = anchorsByFile.get(absoluteTarget)
    if (!anchors) {
      anchors = headingAnchors(targetSource)
      anchorsByFile.set(absoluteTarget, anchors)
    }
    if (!anchors.has(anchor)) {
      failures.push(`${file}: missing heading #${anchor} in ${targetPath || file}`)
    }
  }
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join('\n')}\n`)
  process.exitCode = 1
} else {
  process.stdout.write(
    `Checked ${files.length} Markdown files and local heading links.\n`,
  )
}
