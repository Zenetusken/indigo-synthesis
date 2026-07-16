import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import {
  subjectExportReadContract,
  subjectExportReadManifest,
} from '@/modules/data-portability/infrastructure/scoped-subject-export'

const approvedAdapterImports = new Map<string, ReadonlySet<string>>([
  ['drizzle-orm', new Set(['and', 'asc', 'eq', 'inArray', 'sql'])],
  ['drizzle-orm/node-postgres', new Set(['NodePgDatabase'])],
  [
    '@/modules/data-portability/application/export',
    new Set(['DataExportError', 'DataExportFiles']),
  ],
  [
    '@/modules/programs/domain/content-eligibility',
    new Set(['evaluatePersistedContentEligibility']),
  ],
  ['@/platform/config/server', new Set(['getServerConfig'])],
  ['@/platform/db/schema', new Set(Object.keys(subjectExportReadContract))],
])

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

function scopedAdapterViolations(value: string): readonly string[] {
  const violations: string[] = []
  if (/\.select\(\s*\)/.test(value)) violations.push('zero-argument select')
  if (/\bsql\s*\./.test(value)) violations.push('sql property API')
  for (const method of ['delete', 'execute', 'insert', 'transaction', 'update']) {
    if (new RegExp(`\\.${method}\\s*\\(`).test(value)) {
      violations.push(`database mutation:${method}`)
    }
  }
  if (
    /from ['"]@\/platform\/db\/(?:client|database-runtime|runtime-registry)['"]/.test(
      value,
    )
  ) {
    violations.push('raw database runtime import')
  }
  return violations
}

function adapterRelationContract(value: string): Readonly<{
  relations: readonly string[]
  violations: readonly string[]
}> {
  const ast = ts.createSourceFile(
    'scoped-subject-export.ts',
    value,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  const relations = new Set<string>()
  const importedByModule = new Map<string, Set<string>>()
  const sqlBindings = new Set<string>()
  const violations: string[] = []
  for (const statement of ast.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    )
      continue
    const module = statement.moduleSpecifier.text
    const approved = approvedAdapterImports.get(module)
    if (!approved) violations.push(`unapproved import:${module}`)
    const clause = statement.importClause
    const bindings = clause?.namedBindings
    if (!clause || clause.name || !bindings) {
      violations.push(`broad import:${module}`)
      continue
    }
    if (ts.isNamespaceImport(bindings)) {
      violations.push(`namespace import:${module}`)
      continue
    }
    const names = importedByModule.get(module) ?? new Set<string>()
    importedByModule.set(module, names)
    for (const element of bindings.elements) {
      const importedName = element.propertyName?.text ?? element.name.text
      names.add(importedName)
      if (element.propertyName) {
        violations.push(`aliased import:${module}:${importedName}`)
      }
      if (module === '@/platform/db/schema') relations.add(element.name.text)
      if (module === 'drizzle-orm' && importedName === 'sql') {
        sqlBindings.add(element.name.text)
      }
    }
  }
  for (const [module, approved] of approvedAdapterImports) {
    const observed = importedByModule.get(module) ?? new Set<string>()
    if (
      observed.size !== approved.size ||
      [...approved].some((name) => !observed.has(name))
    ) {
      violations.push(`import contract:${module}`)
    }
  }

  const observedReads = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ['from', 'fullJoin', 'innerJoin', 'leftJoin', 'rightJoin'].includes(
        node.expression.name.text,
      )
    ) {
      const relation = node.arguments[0]
      if (!relation || !ts.isIdentifier(relation)) {
        violations.push(`non-identifier relation:${node.expression.name.text}`)
      } else {
        observedReads.add(relation.text)
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'select'
    ) {
      const projection = node.arguments[0]
      if (!projection || !ts.isObjectLiteralExpression(projection)) {
        violations.push('non-explicit select projection')
      } else {
        for (const property of projection.properties) {
          if (
            !ts.isPropertyAssignment(property) ||
            !ts.isPropertyAccessExpression(property.initializer) ||
            !ts.isIdentifier(property.initializer.expression) ||
            !relations.has(property.initializer.expression.text)
          ) {
            violations.push('non-column select projection')
          }
        }
      }
    }
    if (ts.isTaggedTemplateExpression(node)) {
      if (!ts.isIdentifier(node.tag) || !sqlBindings.has(node.tag.text)) {
        violations.push('unapproved tagged template')
        ts.forEachChild(node, visit)
        return
      }
      const spans = ts.isTemplateExpression(node.template)
        ? node.template.templateSpans
        : []
      let statement = ts.isTemplateExpression(node.template)
        ? node.template.head.text
        : node.template.text
      for (const [index, span] of spans.entries()) {
        statement += ` __INDIGO_RELATION_${index}__ ${span.literal.text}`
      }
      violations.push(...sqlStatementViolations(statement, { rejectCommas: true }))
      for (const relation of sqlRelations(statement)) {
        const marker = /^__INDIGO_RELATION_(\d+)__$/.exec(relation)
        if (!marker) {
          violations.push(`static sql relation:${relation}`)
          continue
        }
        const index = Number(marker[1])
        const expression = spans[index]?.expression
        if (!expression || !ts.isIdentifier(expression)) {
          violations.push(`indirect sql relation:${relation}`)
        } else if (!relations.has(expression.text)) {
          violations.push(`indirect sql relation:${expression.text}`)
        } else {
          observedReads.add(expression.text)
        }
      }
    }
    if (ts.isIdentifier(node) && sqlBindings.has(node.text)) {
      const parent = node.parent
      const importBinding =
        ts.isImportSpecifier(parent) &&
        (parent.name === node || parent.propertyName === node)
      const directTag = ts.isTaggedTemplateExpression(parent) && parent.tag === node
      if (!importBinding && !directTag) violations.push(`sql non-tag use:${node.text}`)
    }
    if (
      (ts.isPropertyAccessExpression(node) && node.name.text === 'raw') ||
      (ts.isElementAccessExpression(node) &&
        ts.isStringLiteralLike(node.argumentExpression) &&
        node.argumentExpression.text === 'raw')
    ) {
      violations.push('raw SQL property access')
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  for (const relation of observedReads) {
    if (!relations.has(relation)) violations.push(`indirect relation:${relation}`)
  }
  for (const relation of relations) {
    if (!observedReads.has(relation))
      violations.push(`unused schema relation:${relation}`)
  }
  return Object.freeze({
    relations: [...relations].sort(),
    violations: [...new Set(violations)].sort(),
  })
}

function sqlRelations(value: string): readonly string[] {
  const relations = new Set<string>()
  const pattern =
    /\b(?:FROM|JOIN)\s+((?:"[A-Za-z_][A-Za-z0-9_]*"|[A-Za-z_][A-Za-z0-9_]*)(?:\s*\.\s*(?:"[A-Za-z_][A-Za-z0-9_]*"|[A-Za-z_][A-Za-z0-9_]*))?)/gi
  for (const match of value.matchAll(pattern)) {
    const qualified = match[1]
    if (!qualified) continue
    const relation = qualified.split('.').at(-1)?.trim().replaceAll('"', '')
    if (relation) relations.add(relation)
  }
  return [...relations].sort()
}

function sqlStatementViolations(
  value: string,
  options: Readonly<{ rejectCommas?: boolean }> = {},
): readonly string[] {
  const violations: string[] = []
  if (/--|\/\*/.test(value)) {
    violations.push('unsupported SQL comment')
  }
  const identifier = '(?:"[A-Za-z_][A-Za-z0-9_]*"|[A-Za-z_][A-Za-z0-9_]*)'
  const relationToken = `(?:__INDIGO_RELATION_\\d+__|${identifier})(?:\\s*\\.\\s*${identifier})?`
  const alias = `(?:\\s+(?:AS\\s+)?${identifier}(?:\\s*\\([^)]*\\))?)?`
  if (
    (options.rejectCommas && value.includes(',')) ||
    new RegExp(`\\b(?:FROM|JOIN)\\s+${relationToken}${alias}\\s*,`, 'i').test(value)
  ) {
    violations.push('unsupported comma relation grammar')
  }
  if (/\bTABLE\b/i.test(value)) {
    violations.push('unsupported TABLE relation grammar')
  }
  const mutation =
    /\b(?:ALTER|CALL|COPY|CREATE|DELETE|DO|DROP|GRANT|INSERT|INTO|LOCK|MERGE|REFRESH|RESET|REVOKE|SET|TRUNCATE|UPDATE|VACUUM)\b/i.exec(
      value,
    )
  if (mutation?.[0]) {
    violations.push(`SQL mutation verb:${mutation[0].toUpperCase()}`)
  }
  return violations
}

function identityAuthorityQueryContract(value: string): Readonly<{
  relations: readonly string[]
  violations: readonly string[]
}> {
  const ast = ts.createSourceFile(
    'subject-export-authority.ts',
    value,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  const violations: string[] = []
  let statement: string | undefined
  let statementDeclarations = 0
  let queryCalls = 0
  let statementDeclaration: ts.VariableDeclaration | undefined

  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'subjectExportAuthorityStatement'
    ) {
      statementDeclarations += 1
      statementDeclaration = node
      const declarationList = node.parent
      const declarationStatement = declarationList.parent
      if (
        !ts.isVariableDeclarationList(declarationList) ||
        (declarationList.flags & ts.NodeFlags.Const) === 0 ||
        !ts.isVariableStatement(declarationStatement) ||
        declarationStatement.parent !== ast
      ) {
        violations.push('authority statement is not one top-level const')
      }
      if (!node.initializer || !ts.isNoSubstitutionTemplateLiteral(node.initializer)) {
        violations.push('authority statement is not one static template')
      } else {
        statement = node.initializer.text
      }
    }
    if (ts.isIdentifier(node) && node.text === 'subjectExportAuthorityStatement') {
      const declarationName = statementDeclaration?.name === node
      const directQueryArgument =
        ts.isCallExpression(node.parent) &&
        node.parent.arguments[0] === node &&
        ts.isPropertyAccessExpression(node.parent.expression) &&
        ts.isIdentifier(node.parent.expression.expression) &&
        node.parent.expression.expression.text === 'query' &&
        node.parent.expression.name.text === 'query'
      if (!declarationName && !directQueryArgument) {
        violations.push('indirect authority statement use')
      }
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === 'query' &&
      !ts.isCallExpression(node.parent)
    ) {
      violations.push('indirect query method use')
    }
    if (
      ts.isElementAccessExpression(node) &&
      ((ts.isIdentifier(node.expression) && node.expression.text === 'query') ||
        (ts.isStringLiteralLike(node.argumentExpression) &&
          node.argumentExpression.text === 'query'))
    ) {
      violations.push('computed query method use')
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'query'
    ) {
      queryCalls += 1
      if (
        !ts.isIdentifier(node.expression.expression) ||
        node.expression.expression.text !== 'query'
      ) {
        violations.push('indirect query capability use')
      }
      const statementArgument = node.arguments[0]
      if (
        !statementArgument ||
        !ts.isIdentifier(statementArgument) ||
        statementArgument.text !== 'subjectExportAuthorityStatement'
      ) {
        violations.push('query does not use the authority statement')
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  if (statementDeclarations !== 1) {
    violations.push('authority statement declaration count')
  }
  if (queryCalls !== 1) violations.push('authority query call count')
  if (statement) violations.push(...sqlStatementViolations(statement))
  return Object.freeze({
    relations: statement ? sqlRelations(statement) : [],
    violations: [...new Set(violations)].sort(),
  })
}

describe('subject export boundaries', () => {
  it('keeps archive finalization pure and database-blind', () => {
    const application = source('src/modules/data-portability/application/export.ts')
    expect(application).toContain('finalizeDataExport')
    expect(application).not.toMatch(
      /drizzle-orm|@\/platform\/db|\.select\(|\.transaction\(/,
    )
  })

  it('keeps the route on nominal command and production composition seams only', () => {
    const route = source('src/app/api/export/route.ts')
    expect(route).toContain('captureSubjectExportCommand')
    expect(route).toContain('getProductionDataPortabilitySubjectExportPort')
    expect(route).not.toMatch(
      /getActor|createDataExport|scoped-subject-export|subject-export-authority|@\/platform\/db/,
    )
  })

  it('pins the temporary scoped adapter to explicit SELECT projections only', () => {
    const adapter = source(
      'src/modules/data-portability/infrastructure/scoped-subject-export.ts',
    )
    expect(scopedAdapterViolations(adapter)).toEqual([])
    expect(adapter).toContain('subjectExportReadManifest')
    expect(adapter).toContain('SubjectExportGraphInvariantError')
    expect(adapter).toContain('metadata: _metadata')
    expect(adapter).toContain('metadata: {}')
    expect(adapterRelationContract(adapter)).toEqual({
      relations: Object.keys(subjectExportReadContract).sort(),
      violations: [],
    })
    expect(subjectExportReadManifest).toEqual(Object.values(subjectExportReadContract))

    expect(
      scopedAdapterViolations(`${adapter}\nvoid database.select().from(secretTable)`),
    ).toContain('zero-argument select')
    expect(
      scopedAdapterViolations(`${adapter}\nvoid database.insert(secretTable)`),
    ).toContain('database mutation:insert')
    expect(
      adapterRelationContract(
        `${adapter}\nvoid database.select({ id: account.id }).from(account)`,
      ).violations,
    ).toContain('indirect relation:account')
    expect(
      adapterRelationContract(
        `${adapter}\nvoid database.select({ password: sql\`(SELECT password FROM account LIMIT 1)\` }).from(user)`,
      ).violations,
    ).toContain('static sql relation:account')
    expect(
      adapterRelationContract(
        adapter.replace(
          ['FROM $', '{programRevisions} AS revision'].join(''),
          ['FROM $', '{programRevisions} AS revision, account AS credential'].join(''),
        ),
      ).violations,
    ).toContain('unsupported comma relation grammar')
    expect(
      adapterRelationContract(
        adapter.replace(
          ['FROM $', '{programRevisions} AS revision'].join(''),
          [
            'FROM $',
            '{programRevisions} AS revision /* reviewed */, account AS credential',
          ].join(''),
        ),
      ).violations,
    ).toContain('unsupported SQL comment')
    expect(
      adapterRelationContract(
        adapter.replace(
          ['FROM $', '{programRevisions} AS revision'].join(''),
          ['FROM $', '{programRevisions} AS "revision", account AS credential'].join(''),
        ),
      ).violations,
    ).toContain('unsupported comma relation grammar')
    expect(
      adapterRelationContract(
        `${adapter}\nvoid database.select({ password: sql\`EXISTS (TABLE account)\` }).from(user)`,
      ).violations,
    ).toContain('unsupported TABLE relation grammar')
    expect(
      adapterRelationContract(
        `${adapter}\nvoid database.select({ password: sql.raw('(SELECT password FROM account LIMIT 1)') }).from(user)`,
      ).violations,
    ).toContain('raw SQL property access')
    expect(
      adapterRelationContract(
        `${adapter}\nconst q = sql\nvoid database.select({ password: q\`(SELECT password FROM account LIMIT 1)\` }).from(user)`,
      ).violations,
    ).toContain('sql non-tag use:sql')
    expect(
      adapterRelationContract(
        `${adapter}\nvoid database.select({ password: sql /* comment */ ['raw']('(SELECT password FROM account LIMIT 1)') }).from(user)`,
      ).violations,
    ).toContain('raw SQL property access')
    const aliasedSql = adapter
      .replace(
        "import { and, asc, eq, inArray, sql } from 'drizzle-orm'",
        "import { and, asc, eq, inArray, sql as q } from 'drizzle-orm'",
      )
      .replace('sql`EXISTS', 'q`EXISTS')
    expect(adapterRelationContract(aliasedSql).violations).toContain(
      'aliased import:drizzle-orm:sql',
    )
  })

  it('keeps composition database-blind outside the reviewed UoW and capture factories', () => {
    const composition = source('src/composition/data-portability-subject-export.ts')
    expect(composition).toContain('createRuntimePostgresUnitOfWork')
    expect(composition).toContain('withTrustedCredentialCapture')
    expect(composition).toContain('recheckSubjectExportAuthority')
    expect(composition).not.toMatch(
      /@\/platform\/db\/(?:client|schema|database-runtime|runtime-registry)|\.transaction\(/,
    )
  })

  it('keeps the Identity capture query credential-secret blind', () => {
    const identity = source(
      'src/modules/identity/infrastructure/subject-export-authority.ts',
    )
    expect(identity).toContain('FROM installation_state')
    expect(identity).toContain('FROM "session"')
    expect(identity).toContain('FROM "user"')
    const cteRelations = new Set(['actors', 'installation', 'matched_sessions'])
    const contract = identityAuthorityQueryContract(identity)
    expect(contract.violations).toEqual([])
    expect(contract.relations.filter((name) => !cteRelations.has(name))).toEqual([
      'installation_state',
      'session',
      'user',
    ])
    expect(identity).not.toMatch(/credential_rows|\b[A-Za-z_][\w]*\.password\b/)

    expect(
      identityAuthorityQueryContract(
        identity.replace(
          'FROM installation_state',
          ['FROM $', '{relationName}'].join(''),
        ),
      ).violations,
    ).toContain('authority statement is not one static template')
    expect(
      identityAuthorityQueryContract(
        `${identity}\nvoid query.query('SELECT credential.password FROM public.account AS credential')`,
      ).violations,
    ).toContain('query does not use the authority statement')
    expect(
      identityAuthorityQueryContract(
        identity
          .replace(
            'const subjectExportAuthorityStatement',
            'let subjectExportAuthorityStatement',
          )
          .replace(
            'const result = await query.query<SnapshotRow>',
            "subjectExportAuthorityStatement = ['SELECT credential_secret FROM ', 'account'].join('')\n  const result = await query.query<SnapshotRow>",
          ),
      ).violations,
    ).toEqual(
      expect.arrayContaining([
        'authority statement is not one top-level const',
        'indirect authority statement use',
      ]),
    )
    expect(
      identityAuthorityQueryContract(
        identity.replace('query.query<SnapshotRow>', "query['query']<SnapshotRow>"),
      ).violations,
    ).toEqual(
      expect.arrayContaining(['computed query method use', 'authority query call count']),
    )
    expect(
      identityAuthorityQueryContract(
        identity.replace('query.query<SnapshotRow>', 'query[method]<SnapshotRow>'),
      ).violations,
    ).toEqual(
      expect.arrayContaining(['computed query method use', 'authority query call count']),
    )
    expect(
      identityAuthorityQueryContract(
        identity.replace(
          'WITH installation AS MATERIALIZED (',
          'WITH deleted AS (DELETE FROM "user" WHERE false RETURNING id), installation AS MATERIALIZED (',
        ),
      ).violations,
    ).toContain('SQL mutation verb:DELETE')
  })
})
