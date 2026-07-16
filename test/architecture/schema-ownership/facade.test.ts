import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  adapterConfiguredOutsideIdentity,
  configuresDrizzleAdapter,
  listSourceFiles,
} from '../schema-ownership-scan'

describe('schema ownership facade', () => {
  it('classifies Better Auth adapter namespace imports as adapter authority', () => {
    const source =
      "import * as adapters from 'better-auth/adapters/drizzle'\n" +
      'export const adapter = adapters.drizzleAdapter(database, options)\n'

    expect(configuresDrizzleAdapter(source)).toBe(true)
    expect(
      adapterConfiguredOutsideIdentity(
        'src/modules/progress/infrastructure/auth.ts',
        source,
      ),
    ).toBe(true)
    expect(
      adapterConfiguredOutsideIdentity(
        'src/modules/identity/infrastructure/auth.ts',
        source,
      ),
    ).toBe(false)
  })

  it('does not classify unrelated Better Auth namespace imports as adapters', () => {
    expect(
      configuresDrizzleAdapter(
        "import * as crypto from 'better-auth/crypto'\nvoid crypto\n",
      ),
    ).toBe(false)
  })

  it.each([
    "import adapter from 'better-auth/adapters/drizzle'\nvoid adapter",
    "export { drizzleAdapter } from 'better-auth/adapters/drizzle'",
    "export * from 'better-auth/adapters/drizzle'",
    "const adapter = await import('better-auth/adapters/drizzle')",
    "const adapter = require('better-auth/adapters/drizzle')",
    "const load = require\nconst adapter = load('better-auth/adapters/drizzle')",
    "const path = 'better-auth/adapters/' + 'drizzle'\nconst adapter = import(path)",
    "const path = enabled && 'better-auth/adapters/drizzle'\nconst adapter = import(path)",
    "import adapter = require('better-auth/adapters/drizzle')",
    "import { createRequire as makeRequire } from 'node:module'\nconst load = makeRequire(import.meta.url)\nconst adapter = load('better-auth/adapters/drizzle')",
    "const adapter = require.call(null, 'better-auth/adapters/drizzle')",
    "const adapter = Reflect.apply(require, null, ['better-auth/adapters/drizzle'])",
    "const adapter = require.bind(null)('better-auth/adapters/drizzle')",
    "const adapter = module.require('better-auth/adapters/drizzle')",
  ])('fails closed for other static adapter capability paths', (source) => {
    expect(configuresDrizzleAdapter(source)).toBe(true)
    expect(
      adapterConfiguredOutsideIdentity('src/modules/progress/adapter.ts', source),
    ).toBe(true)
  })

  it.each([
    [
      'CommonJS-destructured createRequire',
      "const { createRequire } = require('node:module')\nconst load = createRequire(__filename)\nload('better-auth/adapters/drizzle')",
    ],
    [
      'CommonJS module namespace',
      "const nodeModule = require('module')\nconst load = nodeModule.createRequire(__filename)\nload('better-auth/adapters/drizzle')",
    ],
    [
      'dynamic-import-destructured createRequire',
      "const { createRequire } = await import('node:module')\nconst load = createRequire(import.meta.url)\nload('better-auth/adapters/drizzle')",
    ],
    [
      'dynamic module namespace',
      "const nodeModule = await import('module')\nconst load = nodeModule.createRequire(import.meta.url)\nload('better-auth/adapters/drizzle')",
    ],
    [
      'default module import',
      "import nodeModule from 'node:module'\nconst load = nodeModule.createRequire(import.meta.url)\nload('better-auth/adapters/drizzle')",
    ],
    [
      'ESM module namespace',
      "import * as nodeModule from 'node:module'\nconst load = nodeModule.createRequire(import.meta.url)\nload('better-auth/adapters/drizzle')",
    ],
    [
      'named Module import',
      "import { Module } from 'module'\nconst load = Module.createRequire(import.meta.url)\nload('better-auth/adapters/drizzle')",
    ],
    [
      'process builtin-module lookup',
      "const nodeModule = process.getBuiltinModule('node:module')\nconst load = nodeModule.createRequire(__filename)\nload('better-auth/adapters/drizzle')",
    ],
    [
      'global process builtin-module lookup',
      "const nodeModule = globalThis.process.getBuiltinModule('module')\nconst load = nodeModule.createRequire(__filename)\nload('better-auth/adapters/drizzle')",
    ],
    [
      'global CommonJS module lookup',
      "const nodeModule = global.require('node:module')\nconst load = nodeModule.createRequire(__filename)\nload('better-auth/adapters/drizzle')",
    ],
    [
      'globalThis CommonJS module lookup',
      "const nodeModule = globalThis.require('module')\nconst load = nodeModule.createRequire(__filename)\nload('better-auth/adapters/drizzle')",
    ],
    ['global require', "global.require('better-auth/adapters/drizzle')"],
    ['globalThis require', "globalThis.require('better-auth/adapters/drizzle')"],
    [
      'forwarded globalThis require',
      "const load = globalThis.require\nload('better-auth/adapters/drizzle')",
    ],
    ['global module.require', "global.module.require('better-auth/adapters/drizzle')"],
    [
      'globalThis module.require',
      "globalThis.module.require('better-auth/adapters/drizzle')",
    ],
  ])('detects adapter loading through %s', (_name, source) => {
    expect(configuresDrizzleAdapter(source)).toBe(true)
  })

  it.each([
    "const path = enabled ? 'better-auth/adapters/drizzle' : runtimePath\nimport(path)",
    "const path = runtimePath ?? 'better-auth/adapters/drizzle'\nrequire(path)",
  ])('detects a statically known adapter branch in a path expression', (source) => {
    expect(configuresDrizzleAdapter(source)).toBe(true)
  })

  it.each([
    [
      'declaration destructuring from an ambient global',
      "const { require: load } = globalThis\nload('better-auth/adapters/drizzle')",
    ],
    [
      'assignment destructuring from an ambient global',
      "let load: (value: string) => unknown\n;({ require: load } = globalThis)\nload('better-auth/adapters/drizzle')",
    ],
    [
      'a statically assigned path',
      "let path = 'safe-package'\npath = 'better-auth/adapters/drizzle'\nrequire(path)",
    ],
    [
      'a destructuring-assigned path',
      "let path = 'safe-package'\n;({ path } = { path: 'better-auth/adapters/drizzle' })\nrequire(path)",
    ],
  ])('tracks %s', (_name, source) => {
    expect(configuresDrizzleAdapter(source)).toBe(true)
  })

  it.each([
    [
      'a named function',
      "function load(path: string) { return require(path) }\nload('better-auth/adapters/drizzle')",
    ],
    [
      'an arrow invoked with call',
      "const load = (path: string) => require(path)\nload.call(null, 'better-auth/adapters/drizzle')",
    ],
    [
      'a function expression invoked with apply',
      "const load = function (path: string) { return require(path) }\nload.apply(null, ['better-auth/adapters/drizzle'])",
    ],
    [
      'an arrow invoked with Reflect.apply',
      "const load = (path: string) => import(path)\nReflect.apply(load, null, ['better-auth/adapters/drizzle'])",
    ],
  ])('tracks bounded local loader forwarding through %s', (_name, source) => {
    expect(configuresDrizzleAdapter(source)).toBe(true)
  })

  it.each([
    "function load(path: string) { return require(path) }\nload.call(null, 'safe-package', 'better-auth/adapters/drizzle')",
    "const load = (path: string) => require(path)\nload.apply(null, ['safe-package', 'better-auth/adapters/drizzle'])",
    "const load = (path: string) => import(path)\nReflect.apply(load, null, ['safe-package', 'better-auth/adapters/drizzle'])",
    "function load(loader: (value: string) => unknown, path: string) { return loader(path) }\nload(require, 'safe-package')\nload(console.log, 'better-auth/adapters/drizzle')",
  ])('uses exact local-helper call-site argument positions', (source) => {
    expect(configuresDrizzleAdapter(source)).toBe(false)
  })

  it('keeps namespace module blocks lexical while retaining their inner var flow', () => {
    expect(
      configuresDrizzleAdapter(
        "namespace Runtime {\n  var path = 'better-auth/adapters/drizzle'\n  require(path)\n}",
      ),
    ).toBe(true)
    expect(
      configuresDrizzleAdapter(
        "namespace Documentation { var path = 'better-auth/adapters/drizzle' }\nrequire(path)",
      ),
    ).toBe(false)
    expect(
      configuresDrizzleAdapter(
        "namespace Local { const require = (value: string) => value }\nrequire('better-auth/adapters/drizzle')",
      ),
    ).toBe(true)
  })

  it.each([
    "declare const require: (value: string) => unknown\nrequire('better-auth/adapters/drizzle')",
    "declare function require(value: string): unknown\nrequire('better-auth/adapters/drizzle')",
    "declare const module: { require(value: string): unknown }\nmodule.require('better-auth/adapters/drizzle')",
    "declare const process: { getBuiltinModule(value: string): typeof import('node:module') }\nconst load = process.getBuiltinModule('module').createRequire(__filename)\nload('better-auth/adapters/drizzle')",
    "declare const globalThis: { require(value: string): unknown }\nglobalThis.require('better-auth/adapters/drizzle')",
    "declare const global: { require(value: string): unknown }\nglobal.require('better-auth/adapters/drizzle')",
    "export {}\ndeclare global { var require: (value: string) => unknown }\nrequire('better-auth/adapters/drizzle')",
  ])('does not let an erased declaration shadow an ambient loader', (source) => {
    expect(configuresDrizzleAdapter(source)).toBe(true)
  })

  it.each([
    "require.bind(null, 'better-auth/adapters/drizzle')()",
    "const load = require.bind(null, 'better-auth/adapters/drizzle')\nload()",
    "const bound = require.bind(null, 'better-auth/adapters/drizzle')\nconst load = bound\nload()",
    "const bound = require.bind(null, 'better-auth/adapters/drizzle')\nconst load = bound.bind(null)\nload()",
    "const load = enabled ? require.bind(null, 'safe-package') : require\nload('better-auth/adapters/drizzle')",
    "const load = module.require.bind(module, 'better-auth/adapters/drizzle')\nload()",
    "const args = ['better-auth/adapters/drizzle']\nrequire.apply(null, [...args])",
    "const args = ['better-auth/adapters/drizzle']\nReflect.apply(require, null, [...args])",
    "const prefix: string[] = []\nconst args = ['better-auth/adapters/drizzle']\nReflect.apply(require, null, [...prefix, ...args])",
  ])('tracks pre-bound and statically spread loader arguments', (source) => {
    expect(configuresDrizzleAdapter(source)).toBe(true)
  })

  it.each([
    "require.bind(null, 'safe-package')('better-auth/adapters/drizzle')",
    "const load = require.bind(null, 'safe-package')\nload('better-auth/adapters/drizzle')",
    "const bound = require.bind(null, 'safe-package')\nconst load = bound.bind(null, 'better-auth/adapters/drizzle')\nload()",
    "const load = enabled ? require.bind(null, 'safe-package') : require.bind(null, 'another-safe-package')\nload('better-auth/adapters/drizzle')",
    "require.apply(null, ['safe-package', 'better-auth/adapters/drizzle'])",
    "Reflect.apply(require, null, ['safe-package', 'better-auth/adapters/drizzle'])",
    "const args = ['safe-package', 'better-auth/adapters/drizzle']\nReflect.apply(require, null, [...args])",
  ])('uses the exact effective argument of a forwarded loader', (source) => {
    expect(configuresDrizzleAdapter(source)).toBe(false)
  })

  it.each([
    "function getLoader() { return require }\ngetLoader()('better-auth/adapters/drizzle')",
    "const getLoader = () => (path: string) => import(path)\ngetLoader()('better-auth/adapters/drizzle')",
    "function adapterPath() { return 'better-auth/adapters/drizzle' }\nrequire(adapterPath())",
    "const adapterPath = () => enabled ? 'better-auth/adapters/drizzle' : runtimePath\nimport(adapterPath())",
    "const capabilities = { load: require }\ncapabilities.load('better-auth/adapters/drizzle')",
    "const capabilities = [require]\ncapabilities[0]('better-auth/adapters/drizzle')",
    "const { load } = { load: require }\nload('better-auth/adapters/drizzle')",
    "let load: (value: string) => unknown\n;({ load } = { load: require })\nload('better-auth/adapters/drizzle')",
    "let load: (value: string) => unknown\n;[load] = [require]\nload('better-auth/adapters/drizzle')",
  ])('tracks bounded returned and stored loader capability flow', (source) => {
    expect(configuresDrizzleAdapter(source)).toBe(true)
  })

  it.each([
    "class Loaders { load = require }\nnew Loaders().load('better-auth/adapters/drizzle')",
    "class Loaders { ['load'] = require }\nconst loaders = new Loaders()\nloaders.load('better-auth/adapters/drizzle')",
    "class Loaders { static load = require }\nLoaders.load('better-auth/adapters/drizzle')",
    "const loaders: { load?: (value: string) => unknown } = {}\nloaders.load = require\nloaders.load('better-auth/adapters/drizzle')",
    "const loaders: Record<string, unknown> = {}\nloaders['load'] = require\nloaders['load']('better-auth/adapters/drizzle')",
    "class Loaders {}\nLoaders.load = require\nLoaders.load('better-auth/adapters/drizzle')",
  ])('tracks bounded class and property loader storage', (source) => {
    expect(configuresDrizzleAdapter(source)).toBe(true)
  })

  it.each([
    "class Loaders { load = (value: string) => value }\nnew Loaders().load('better-auth/adapters/drizzle')",
    "class Loaders { static load = require }\nnew Loaders().load('better-auth/adapters/drizzle')",
    "class Loaders { load = require }\nLoaders.load('better-auth/adapters/drizzle')",
    "const first: Record<string, unknown> = {}\nconst second: Record<string, unknown> = {}\nfirst.load = require\nsecond.load('better-auth/adapters/drizzle')",
    "function local(require: (value: string) => unknown) {\n  const loaders: { load?: (value: string) => unknown } = {}\n  loaders.load = require\n  return loaders.load('better-auth/adapters/drizzle')\n}",
  ])('does not invent loader authority for safe class/property storage', (source) => {
    expect(configuresDrizzleAdapter(source)).toBe(false)
  })

  it('matches only the exact Better Auth Drizzle adapter package family', () => {
    expect(
      configuresDrizzleAdapter(
        "import adapter from 'better-auth/adapters/drizzle/runtime'\nvoid adapter",
      ),
    ).toBe(true)
    for (const specifier of [
      '@scope/better-auth/adapters/drizzle',
      './better-auth/adapters/drizzle',
      '../node_modules/better-auth/adapters/drizzle',
      'wrapper/better-auth/adapters/drizzle',
      'better-auth/adapters/drizzled',
    ]) {
      expect(configuresDrizzleAdapter(`require('${specifier}')`)).toBe(false)
    }
  })

  it('treats an empty named runtime import as a module load', () => {
    expect(
      configuresDrizzleAdapter("import {} from 'better-auth/adapters/drizzle'"),
    ).toBe(true)
    expect(
      configuresDrizzleAdapter("import type {} from 'better-auth/adapters/drizzle'"),
    ).toBe(false)
  })

  it('treats an empty named runtime re-export as a module load', () => {
    expect(
      configuresDrizzleAdapter("export {} from 'better-auth/adapters/drizzle'"),
    ).toBe(true)
    expect(
      configuresDrizzleAdapter("export type {} from 'better-auth/adapters/drizzle'"),
    ).toBe(false)
  })

  it.each([
    "const load = (0, require)\nload('better-auth/adapters/drizzle')",
    ";(0, require)('better-auth/adapters/drizzle')",
    "const load = enabled ? require : safeLoader\nload('better-auth/adapters/drizzle')",
    ";(enabled && require)('better-auth/adapters/drizzle')",
    ";(safeLoader || require)('better-auth/adapters/drizzle')",
    "const load = enabled ? require.bind(null, 'safe-package') : require\nload('better-auth/adapters/drizzle')",
  ])('tracks sequence, conditional, and logical loader callees', (source) => {
    expect(configuresDrizzleAdapter(source)).toBe(true)
  })

  it.each([
    "const load = (require, safeLoader)\nload('better-auth/adapters/drizzle')",
    "const load = enabled ? require.bind(null, 'safe-package') : safeLoader\nload('better-auth/adapters/drizzle')",
    ";(enabled ? safeLoader : anotherSafeLoader)('better-auth/adapters/drizzle')",
  ])('does not invent sequence or alternative loader authority', (source) => {
    expect(configuresDrizzleAdapter(source)).toBe(false)
  })

  it.each([
    "function load(path = 'better-auth/adapters/drizzle') { return require(path) }\nload()",
    "const load = (path = 'better-auth/adapters/drizzle') => import(path)\nload.call(null)",
    "function load(path = 'safe-package') { return require(path) }\nload('better-auth/adapters/drizzle')",
    "function load(loader = require, path = 'better-auth/adapters/drizzle') { return loader(path) }\nload()",
    "function load(path = 'better-auth/adapters/drizzle') { return require(path) }\nload(undefined)",
    "export function load(path = 'better-auth/adapters/drizzle') { return require(path) }",
  ])('tracks effective local-helper default module paths', (source) => {
    expect(configuresDrizzleAdapter(source)).toBe(true)
  })

  it.each([
    "function load(path = 'better-auth/adapters/drizzle') { return require(path) }\nload('safe-package')",
    "const load = (path = 'better-auth/adapters/drizzle') => import(path)\nload.apply(null, ['safe-package'])",
    "function load(loader = require, path = 'better-auth/adapters/drizzle') { return loader(path) }\nload(console.log, 'safe-package')",
  ])('lets explicit helper arguments override defaults exactly', (source) => {
    expect(configuresDrizzleAdapter(source)).toBe(false)
  })

  it.each([
    [
      'a same-named path binding in another function',
      "function docs() {\n  const path = 'better-auth/adapters/drizzle'\n  return path\n}\nasync function load(path: string) {\n  return import(path)\n}\nload('safe-package')",
    ],
    [
      'a shadowed require parameter',
      "function load(require: (value: string) => unknown) {\n  return require('better-auth/adapters/drizzle')\n}",
    ],
    [
      'a shadowed createRequire parameter',
      "function load(createRequire: (value: string) => (module: string) => unknown) {\n  const require = createRequire(__filename)\n  return require('better-auth/adapters/drizzle')\n}",
    ],
    [
      'a shadowed module parameter',
      "function load(module: { require(value: string): unknown }) {\n  return module.require('better-auth/adapters/drizzle')\n}",
    ],
    [
      'a shadowed globalThis parameter',
      "function load(globalThis: { require(value: string): unknown }) {\n  return globalThis.require('better-auth/adapters/drizzle')\n}",
    ],
    [
      'a shadowed global parameter',
      "function load(global: { module: { require(value: string): unknown }, require(value: string): unknown }) {\n  global.require('better-auth/adapters/drizzle')\n  return global.module.require('better-auth/adapters/drizzle')\n}",
    ],
    [
      'a shadowed process parameter',
      "function load(process: { getBuiltinModule(value: string): any }) {\n  const nodeModule = process.getBuiltinModule('node:module')\n  return nodeModule.createRequire(__filename)('better-auth/adapters/drizzle')\n}",
    ],
    [
      'a shadowed Reflect parameter',
      "function load(Reflect: { apply(...values: unknown[]): unknown }) {\n  return Reflect.apply(require, null, ['better-auth/adapters/drizzle'])\n}",
    ],
  ])('does not infer adapter authority from %s', (_name, source) => {
    expect(configuresDrizzleAdapter(source)).toBe(false)
  })

  it('ignores type-only adapter imports', () => {
    expect(
      configuresDrizzleAdapter(
        "import type { DrizzleAdapter } from 'better-auth/adapters/drizzle'",
      ),
    ).toBe(false)
    expect(
      configuresDrizzleAdapter(
        "import type adapter = require('better-auth/adapters/drizzle')",
      ),
    ).toBe(false)
  })

  it.each([
    "import type { createRequire } from 'node:module'\nconst load = createRequire(import.meta.url)\nload('better-auth/adapters/drizzle')",
    "import type nodeModule from 'node:module'\nconst load = nodeModule.createRequire(import.meta.url)\nload('better-auth/adapters/drizzle')",
    "import type { Module } from 'node:module'\nconst load = Module.createRequire(import.meta.url)\nload('better-auth/adapters/drizzle')",
    "import { type Module } from 'node:module'\nconst load = Module.createRequire(import.meta.url)\nload('better-auth/adapters/drizzle')",
  ])('ignores type-only Node module loader imports', (source) => {
    expect(configuresDrizzleAdapter(source)).toBe(false)
  })

  it('does not classify ordinary adapter-path strings or similarly named packages', () => {
    expect(configuresDrizzleAdapter("console.log('better-auth/adapters/drizzle')")).toBe(
      false,
    )
    expect(
      configuresDrizzleAdapter(
        "import { drizzleAdapter } from 'example-better-auth-wrapper'\nvoid drizzleAdapter",
      ),
    ).toBe(false)
  })

  it('scans every production JavaScript and TypeScript module extension', () => {
    const directory = mkdtempSync(join(tmpdir(), 'indigo-schema-perimeter-'))
    try {
      const included = [
        'plain.js',
        'component.jsx',
        'module.mjs',
        'common.cjs',
        'typed.ts',
        'typed-view.tsx',
        'typed-module.mts',
        'typed-common.cts',
      ]
      const excluded = [
        'plain.test.js',
        'module.spec.mjs',
        'typed.test.ts',
        'typed.spec.tsx',
        'notes.md',
      ]
      for (const file of [...included, ...excluded]) {
        writeFileSync(join(directory, file), 'export {}\n')
      }

      expect(
        listSourceFiles(directory)
          .map((file) => basename(file))
          .sort(),
      ).toEqual(included.sort())
      expect(readdirSync(directory)).toHaveLength(included.length + excluded.length)
    } finally {
      rmSync(directory, { force: true, recursive: true })
    }
  })
})
