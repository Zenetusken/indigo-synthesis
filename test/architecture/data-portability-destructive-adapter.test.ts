import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { temporaryDestructiveAdapterManifest } from '@/modules/data-portability/infrastructure/destructive-adapter-manifest'
import { crossCuttingOperator, tableWriteFence } from '@/platform/db/schema/ownership'
import { buildSchemaTableMap, scanWrites, type WriteOp } from './schema-ownership-scan'

const sourceRoot = resolve(process.cwd(), 'src')
const adapterPath = resolve(
  sourceRoot,
  'modules/data-portability/infrastructure/scoped-destructive-adapter.ts',
)
const adapterProjectPath =
  'src/modules/data-portability/infrastructure/scoped-destructive-adapter.ts'
const deletionPath = resolve(
  sourceRoot,
  'modules/data-portability/application/deletion.ts',
)
const adapterSource = readFileSync(adapterPath, 'utf8')
const deletionSource = readFileSync(deletionPath, 'utf8')
const adapterAst = ts.createSourceFile(
  adapterPath,
  adapterSource,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
)
const deletionAst = ts.createSourceFile(
  deletionPath,
  deletionSource,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
)
const { bindingToSql, sqlNames } = buildSchemaTableMap(sourceRoot)

function functionSource(ast: ts.SourceFile, source: string, name: string): string {
  let found: string | undefined
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
      found = source.slice(node.getStart(ast), node.getEnd())
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  if (!found) throw new Error(`Missing destructive function: ${name}`)
  return found
}

function functionLineSpan(name: string): readonly [number, number] {
  let found: readonly [number, number] | undefined
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
      found = [
        adapterAst.getLineAndCharacterOfPosition(node.getStart(adapterAst)).line + 1,
        adapterAst.getLineAndCharacterOfPosition(node.getEnd()).line + 1,
      ]
    }
    ts.forEachChild(node, visit)
  }
  visit(adapterAst)
  if (!found) throw new Error(`Missing destructive adapter function: ${name}`)
  return found
}

const writes = scanWrites({ sourceRoot }).filter(
  ({ file }) => file === adapterProjectPath,
)

function observedWrites(name: string, op: WriteOp): string[] {
  const [first, last] = functionLineSpan(name)
  return [
    ...new Set(
      writes
        .filter((write) => write.line >= first && write.line <= last && write.op === op)
        .map(({ table }) => table),
    ),
  ].sort()
}

function observedSelects(...sources: readonly string[]): string[] {
  const selected = new Set<string>()
  for (const source of sources) {
    for (const match of source.matchAll(/\.from\(\s*([A-Za-z_$][\w$]*)\s*\)/g)) {
      const table = match[1] ? bindingToSql.get(match[1]) : undefined
      if (table) selected.add(table)
    }
    for (const match of source.matchAll(/\b(?:FROM|JOIN)\s+"?([a-z_][a-z0-9_]*)"?/gi)) {
      const table = match[1]?.toLowerCase()
      if (!table || !sqlNames.has(table)) continue
      const prefix = source.slice(Math.max(0, (match.index ?? 0) - 10), match.index)
      if (/DELETE\s*$/i.test(prefix)) continue
      selected.add(table)
    }
  }
  return [...selected].sort()
}

describe('temporary Data Portability destructive adapter boundary', () => {
  it('keeps the manifest lexical, duplicate-free, and schema-bounded', () => {
    const schemaTables = new Set(Object.keys(tableWriteFence))
    for (const methods of Object.values(temporaryDestructiveAdapterManifest)) {
      for (const tables of Object.values(methods)) {
        expect([...tables]).toEqual([...new Set(tables)].sort())
        expect(tables.every((table: string) => schemaTables.has(table))).toBe(true)
      }
    }
  })

  it('matches every observed adapter DML verb and table exactly', () => {
    const implementations = {
      invalidatePreviewAfterDenial: 'invalidatePreviewAfterDenial',
      executeSubjectDeletion: 'executeSubjectDeletion',
      executeInstanceReset: 'executeInstanceReset',
    } as const
    for (const [method, implementation] of Object.entries(implementations) as [
      keyof typeof implementations,
      (typeof implementations)[keyof typeof implementations],
    ][]) {
      const manifested = temporaryDestructiveAdapterManifest[method]
      for (const op of ['insert', 'update', 'delete'] as const) {
        expect(observedWrites(implementation, op)).toEqual([...manifested[op]])
      }
    }
    const spans = Object.values(implementations).map(functionLineSpan)
    expect(
      writes.filter(
        ({ line }) => !spans.some(([first, last]) => line >= first && line <= last),
      ),
    ).toEqual([])
  })

  it('matches the exact direct and recount SELECT table surface', () => {
    expect(
      temporaryDestructiveAdapterManifest.invalidatePreviewAfterDenial.select,
    ).toEqual(
      observedSelects(
        functionSource(adapterAst, adapterSource, 'invalidatePreviewAfterDenial'),
      ),
    )
    expect(temporaryDestructiveAdapterManifest.executeSubjectDeletion.select).toEqual(
      observedSelects(
        functionSource(adapterAst, adapterSource, 'executeSubjectDeletion'),
        functionSource(deletionAst, deletionSource, 'countSubjectRows'),
      ),
    )
    expect(temporaryDestructiveAdapterManifest.executeInstanceReset.select).toEqual(
      observedSelects(
        functionSource(adapterAst, adapterSource, 'executeInstanceReset'),
        functionSource(deletionAst, deletionSource, 'countInstanceRows'),
      ),
    )
  })

  it('narrows the cross-cutting delete grant to the adapter non-owner union', () => {
    const expected = [
      ...new Set(
        Object.values(temporaryDestructiveAdapterManifest).flatMap(({ delete: d }) =>
          d.filter((table) => tableWriteFence[table].owner !== 'data-portability'),
        ),
      ),
    ].sort()
    expect([...crossCuttingOperator.allow.delete]).toEqual(expected)
  })

  it('exposes only purpose-specific one-use gateway methods and no database escape', () => {
    expect(adapterSource).toMatch(
      /interface ScopedDeletionAttemptGateway\s*{\s*invalidatePreviewAfterDenial\(\): Promise<void>/,
    )
    expect(adapterSource).toMatch(
      /interface ScopedSubjectDeletionGateway\s*{\s*execute\(\): Promise<void>/,
    )
    expect(adapterSource).toMatch(
      /interface ScopedInstanceResetGateway\s*{\s*execute\(\): Promise<void>/,
    )
    expect(adapterSource).not.toMatch(/\bgetDb\b|\$client|ScopedTransactionClient/)
    expect(adapterSource).not.toContain('.transaction(')
    expect(adapterSource).toContain('function oneUse')
    expect(adapterSource.match(/requireWriteAuthorized\(\)/g)).toHaveLength(3)
  })

  it('leaves previews in application code and removes legacy protected execution', () => {
    expect(deletionSource).toContain('export async function createInstanceResetPlan')
    expect(deletionSource).toContain('export async function createSubjectDeletionPlan')
    expect(deletionSource).not.toMatch(
      /withDestructiveReauthentication|executeSubjectDeletion|executeInstanceReset|deletion_mode|credential-lifecycle-lock/,
    )
  })
})
