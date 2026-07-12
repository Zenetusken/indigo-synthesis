import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createOwnerSecretFile,
  type OwnerSecretFileOptions,
  openOwnerSecretFile,
} from './owner-secret-file'

const label = 'Test secret file'

describe('owner-secret file primitive', () => {
  let directory: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'indigo-owner-secret-'))
    await chmod(directory, 0o700)
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await rm(directory, { recursive: true, force: true })
  })

  function options(path: string, maxBytes = 64): OwnerSecretFileOptions {
    return { path, label, maxBytes }
  }

  async function writeSecretFile(
    path: string,
    value: string | Uint8Array,
    mode = 0o600,
  ): Promise<void> {
    await writeFile(path, value, { mode })
    await chmod(path, mode)
  }

  it('requires an absolute path', async () => {
    await expect(openOwnerSecretFile(options('relative-secret'))).rejects.toMatchObject({
      code: 'owner-secret.path-not-absolute',
    })
  })

  it('rejects a parent writable by group or other users', async () => {
    const path = join(directory, 'secret')
    await writeSecretFile(path, 'value\n')
    await chmod(directory, 0o777)

    await expect(openOwnerSecretFile(options(path))).rejects.toMatchObject({
      code: 'owner-secret.parent-permissions-invalid',
    })
  })

  it.skipIf(typeof process.geteuid !== 'function')(
    'enforces ownership against the effective UID',
    async () => {
      const getEffectiveUid = process.geteuid
      if (!getEffectiveUid) throw new Error('This ownership assertion requires POSIX.')

      const path = join(directory, 'secret')
      await writeSecretFile(path, 'value\n')
      vi.spyOn(process, 'geteuid').mockReturnValue(getEffectiveUid() + 1)

      await expect(openOwnerSecretFile(options(path))).rejects.toMatchObject({
        code: 'owner-secret.parent-owner-invalid',
      })
    },
  )

  it('opens with no-follow and rejects symbolic links', async () => {
    const target = join(directory, 'target')
    const link = join(directory, 'link')
    await writeSecretFile(target, 'value\n')
    await symlink(target, link)

    await expect(openOwnerSecretFile(options(link))).rejects.toMatchObject({
      code: 'owner-secret.file-type-invalid',
    })
  })

  it('rejects non-regular files', async () => {
    const path = join(directory, 'nested-directory')
    await mkdir(path, { mode: 0o700 })

    await expect(openOwnerSecretFile(options(path))).rejects.toMatchObject({
      code: 'owner-secret.file-type-invalid',
    })
  })

  it.each([0o640, 0o700])('rejects unsafe file mode %o', async (mode) => {
    const path = join(directory, `secret-${mode.toString(8)}`)
    await writeSecretFile(path, 'value\n', mode)

    await expect(openOwnerSecretFile(options(path))).rejects.toMatchObject({
      code: 'owner-secret.file-permissions-invalid',
    })
  })

  it.each([0o400, 0o600])('accepts owner-only readable mode %o', async (mode) => {
    const path = join(directory, `secret-${mode.toString(8)}`)
    await writeSecretFile(path, 'value\n', mode)
    const file = await openOwnerSecretFile(options(path))

    try {
      await expect(file.readSecret()).resolves.toBe('value')
    } finally {
      await file.close()
    }
  })

  it('rejects oversized files before reading', async () => {
    const path = join(directory, 'secret')
    await writeSecretFile(path, '123456789')

    await expect(openOwnerSecretFile(options(path, 8))).rejects.toMatchObject({
      code: 'owner-secret.too-large',
    })
  })

  it.each([
    ['empty', '', 'owner-secret.line-invalid'],
    ['multiple lines', 'one\ntwo', 'owner-secret.line-invalid'],
    ['multiple terminal line breaks', 'one\n\n', 'owner-secret.line-invalid'],
    ['carriage return', 'one\rtwo', 'owner-secret.line-invalid'],
    ['NUL', 'one\0two', 'owner-secret.nul-invalid'],
  ])('rejects %s content', async (_case, contents, code) => {
    const path = join(directory, `secret-${_case.replaceAll(' ', '-')}`)
    await writeSecretFile(path, contents)
    const file = await openOwnerSecretFile(options(path))

    try {
      await expect(file.readSecret()).rejects.toMatchObject({ code })
    } finally {
      await file.close()
    }
  })

  it('rejects invalid UTF-8', async () => {
    const path = join(directory, 'secret')
    await writeSecretFile(path, Uint8Array.from([0xc3, 0x28]))
    const file = await openOwnerSecretFile(options(path))

    try {
      await expect(file.readSecret()).rejects.toMatchObject({
        code: 'owner-secret.encoding-invalid',
      })
    } finally {
      await file.close()
    }
  })

  it.each([
    ['without a line break', 'value'],
    ['with LF', 'value\n'],
    ['with CRLF', 'value\r\n'],
  ])('accepts one non-empty line %s', async (_case, contents) => {
    const path = join(directory, `valid-${_case.replaceAll(' ', '-')}`)
    await writeSecretFile(path, contents)
    const file = await openOwnerSecretFile(options(path))

    try {
      await expect(file.readSecret()).resolves.toBe('value')
    } finally {
      await file.close()
    }
  })

  it('reads from the opened descriptor and refuses to unlink a replacement path', async () => {
    const path = join(directory, 'secret')
    const movedPath = join(directory, 'opened-secret')
    await writeSecretFile(path, 'original\n')
    const file = await openOwnerSecretFile(options(path))

    try {
      await rename(path, movedPath)
      await writeSecretFile(path, 'replacement\n')

      await expect(file.readSecret()).resolves.toBe('original')
      await expect(file.consume()).rejects.toMatchObject({
        code: 'owner-secret.path-replaced',
      })
      await expect(readFile(path, 'utf8')).resolves.toBe('replacement\n')
    } finally {
      await file.close()
    }
  })

  it('unlinks the same inode after consuming a secret', async () => {
    const path = join(directory, 'secret')
    await writeSecretFile(path, 'value\n')
    const file = await openOwnerSecretFile(options(path))

    await expect(file.readSecret()).resolves.toBe('value')
    await file.consume()
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reserves a new owner-only file and writes one bounded line', async () => {
    const path = join(directory, 'new-secret')
    const file = await createOwnerSecretFile(options(path))

    try {
      await file.writeSecret('generated')
      await expect(readFile(path, 'utf8')).resolves.toBe('generated\n')
      expect((await stat(path)).mode & 0o777).toBe(0o600)
    } finally {
      await file.close()
    }
  })

  it.each([
    ['multiple lines', 'one\ntwo', 'owner-secret.line-invalid'],
    ['NUL', 'one\0two', 'owner-secret.nul-invalid'],
    ['oversize content', '12345678', 'owner-secret.too-large'],
  ])('refuses to write %s', async (_case, value, code) => {
    const path = join(directory, `new-${_case.replaceAll(' ', '-')}`)
    const file = await createOwnerSecretFile(options(path, 8))

    try {
      await expect(file.writeSecret(value)).rejects.toMatchObject({ code })
      await expect(readFile(path, 'utf8')).resolves.toBe('')
    } finally {
      await file.discard()
    }
  })

  it('refuses to discard a replacement for a reserved output path', async () => {
    const path = join(directory, 'new-secret')
    const movedPath = join(directory, 'reserved-secret')
    const file = await createOwnerSecretFile(options(path))

    try {
      await rename(path, movedPath)
      await writeSecretFile(path, 'replacement\n')

      await expect(file.discard()).rejects.toMatchObject({
        code: 'owner-secret.path-replaced',
      })
      await expect(readFile(path, 'utf8')).resolves.toBe('replacement\n')
    } finally {
      await file.close()
    }
  })

  it('never truncates an existing output path', async () => {
    const path = join(directory, 'existing-secret')
    await writeSecretFile(path, 'keep-me\n')

    await expect(createOwnerSecretFile(options(path))).rejects.toMatchObject({
      code: 'EEXIST',
    })
    await expect(readFile(path, 'utf8')).resolves.toBe('keep-me\n')
  })
})
