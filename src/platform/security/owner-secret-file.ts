import { type BigIntStats, constants } from 'node:fs'
import { type FileHandle, lstat, open, realpath, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

const ownerRead = 0o400
const ownerExecute = 0o100
const ownerExecutableOrAnyGroupOrOtherPermission = 0o177
const groupOrOtherWrite = 0o022

export class OwnerSecretFileError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'OwnerSecretFileError'
  }
}

export type OwnerSecretFileOptions = {
  readonly path: string
  readonly label: string
  readonly maxBytes: number
}

type FileIdentity = {
  readonly device: bigint
  readonly inode: bigint
}

function effectiveUid(): bigint {
  if (typeof process.geteuid !== 'function') {
    throw new OwnerSecretFileError(
      'owner-secret.platform-unsupported',
      'Owner-secret files require POSIX effective-UID and file-mode enforcement.',
    )
  }
  if (typeof constants.O_NOFOLLOW !== 'number' || constants.O_NOFOLLOW === 0) {
    throw new OwnerSecretFileError(
      'owner-secret.platform-unsupported',
      'Owner-secret files require operating-system no-follow file opens.',
    )
  }
  return BigInt(process.geteuid())
}

function validateMaxBytes(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1_048_576) {
    throw new OwnerSecretFileError(
      'owner-secret.max-size-invalid',
      'Owner-secret maximum size must be a positive integer no larger than 1 MiB.',
    )
  }
}

function validateParentMetadata(metadata: BigIntStats, uid: bigint, label: string): void {
  if (!metadata.isDirectory()) {
    throw new OwnerSecretFileError(
      'owner-secret.parent-not-directory',
      `${label} parent must be a directory.`,
    )
  }
  if (metadata.uid !== uid) {
    throw new OwnerSecretFileError(
      'owner-secret.parent-owner-invalid',
      `${label} parent must be owned by the invoking user.`,
    )
  }

  const permissions = Number(metadata.mode & 0o777n)
  if ((permissions & ownerExecute) === 0 || (permissions & groupOrOtherWrite) !== 0) {
    throw new OwnerSecretFileError(
      'owner-secret.parent-permissions-invalid',
      `${label} parent must be owner-accessible and not writable by group or other users.`,
    )
  }
}

function validateFileMetadata(metadata: BigIntStats, uid: bigint, label: string): void {
  if (!metadata.isFile()) {
    throw new OwnerSecretFileError(
      'owner-secret.file-type-invalid',
      `${label} must be a regular file, not a link or special file.`,
    )
  }
  if (metadata.uid !== uid) {
    throw new OwnerSecretFileError(
      'owner-secret.file-owner-invalid',
      `${label} must be owned by the invoking user.`,
    )
  }

  const permissions = Number(metadata.mode & 0o777n)
  if (
    (permissions & ownerRead) === 0 ||
    (permissions & ownerExecutableOrAnyGroupOrOtherPermission) !== 0
  ) {
    throw new OwnerSecretFileError(
      'owner-secret.file-permissions-invalid',
      `${label} must be owner-readable, non-executable, and inaccessible to group and other users.`,
    )
  }
}

function validateFileSize(metadata: BigIntStats, maxBytes: number, label: string): void {
  if (metadata.size > BigInt(maxBytes)) {
    throw new OwnerSecretFileError(
      'owner-secret.too-large',
      `${label} exceeds its ${maxBytes}-byte limit.`,
    )
  }
}

function sameIdentity(left: BigIntStats | FileIdentity, right: BigIntStats): boolean {
  const leftDevice = 'dev' in left ? left.dev : left.device
  const leftInode = 'ino' in left ? left.ino : left.inode
  return leftDevice === right.dev && leftInode === right.ino
}

function unchangedDuringRead(before: BigIntStats, after: BigIntStats): boolean {
  return (
    sameIdentity(before, after) &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs
  )
}

function decodeOneLine(bytes: Uint8Array, label: string): string {
  let raw: string
  try {
    raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new OwnerSecretFileError(
      'owner-secret.encoding-invalid',
      `${label} must contain valid UTF-8 text.`,
    )
  }

  const value = raw.endsWith('\r\n')
    ? raw.slice(0, -2)
    : raw.endsWith('\n')
      ? raw.slice(0, -1)
      : raw

  if (!value || value.includes('\n') || value.includes('\r')) {
    throw new OwnerSecretFileError(
      'owner-secret.line-invalid',
      `${label} must contain exactly one non-empty line.`,
    )
  }
  if (value.includes('\0')) {
    throw new OwnerSecretFileError(
      'owner-secret.nul-invalid',
      `${label} must not contain a NUL byte.`,
    )
  }
  return value
}

function encodeOneLine(value: string, label: string, maxBytes: number): Buffer {
  if (!value || value.includes('\n') || value.includes('\r')) {
    throw new OwnerSecretFileError(
      'owner-secret.line-invalid',
      `${label} must contain exactly one non-empty line.`,
    )
  }
  if (value.includes('\0')) {
    throw new OwnerSecretFileError(
      'owner-secret.nul-invalid',
      `${label} must not contain a NUL byte.`,
    )
  }

  const bytes = Buffer.from(`${value}\n`, 'utf8')
  if (bytes.byteLength > maxBytes) {
    throw new OwnerSecretFileError(
      'owner-secret.too-large',
      `${label} exceeds its ${maxBytes}-byte limit.`,
    )
  }
  return bytes
}

async function canonicalOwnerPath(
  path: string,
  label: string,
  uid: bigint,
): Promise<string> {
  if (!isAbsolute(path)) {
    throw new OwnerSecretFileError(
      'owner-secret.path-not-absolute',
      `${label} path must be absolute.`,
    )
  }

  const normalized = resolve(path)
  const parent = await realpath(dirname(normalized))
  const parentMetadata = await lstat(parent, { bigint: true })
  validateParentMetadata(parentMetadata, uid, label)
  return join(parent, basename(normalized))
}

async function readAtMost(
  handle: FileHandle,
  maxBytes: number,
  label: string,
): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(maxBytes + 1)
  let offset = 0

  while (offset < buffer.byteLength) {
    const { bytesRead } = await handle.read(
      buffer,
      offset,
      buffer.byteLength - offset,
      offset,
    )
    if (bytesRead === 0) break
    offset += bytesRead
  }

  if (offset > maxBytes) {
    throw new OwnerSecretFileError(
      'owner-secret.too-large',
      `${label} exceeds its ${maxBytes}-byte limit.`,
    )
  }
  return buffer.subarray(0, offset)
}

async function writeAll(handle: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(
      bytes,
      offset,
      bytes.byteLength - offset,
      offset,
    )
    if (bytesWritten === 0) throw new Error('Owner-secret write made no progress.')
    offset += bytesWritten
  }
}

abstract class OwnerSecretDescriptor {
  protected closed = false

  constructor(
    protected readonly handle: FileHandle,
    readonly path: string,
    protected readonly label: string,
    protected readonly uid: bigint,
    protected readonly identity: FileIdentity,
  ) {}

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.handle.close()
  }

  protected assertOpen(): void {
    if (this.closed) {
      throw new OwnerSecretFileError(
        'owner-secret.descriptor-closed',
        `${this.label} is already closed.`,
      )
    }
  }

  protected async assertPathStillMatches(): Promise<void> {
    this.assertOpen()
    let pathMetadata: BigIntStats
    try {
      pathMetadata = await lstat(this.path, { bigint: true })
    } catch {
      throw new OwnerSecretFileError(
        'owner-secret.path-replaced',
        `${this.label} path no longer names the opened file; it was not removed.`,
      )
    }
    validateFileMetadata(pathMetadata, this.uid, this.label)
    if (!sameIdentity(this.identity, pathMetadata)) {
      throw new OwnerSecretFileError(
        'owner-secret.path-replaced',
        `${this.label} path no longer names the opened file; it was not removed.`,
      )
    }
  }

  protected async removeMatchingPath(): Promise<void> {
    await this.assertPathStillMatches()
    await unlink(this.path)
  }
}

export class OpenedOwnerSecretFile extends OwnerSecretDescriptor {
  private value: string | undefined

  constructor(
    handle: FileHandle,
    path: string,
    label: string,
    uid: bigint,
    identity: FileIdentity,
    private readonly maxBytes: number,
  ) {
    super(handle, path, label, uid, identity)
  }

  async readSecret(): Promise<string> {
    this.assertOpen()
    if (this.value !== undefined) return this.value

    const before = await this.handle.stat({ bigint: true })
    validateFileMetadata(before, this.uid, this.label)
    if (!sameIdentity(this.identity, before)) {
      throw new OwnerSecretFileError(
        'owner-secret.file-changed',
        `${this.label} changed after it was opened.`,
      )
    }
    validateFileSize(before, this.maxBytes, this.label)

    const bytes = await readAtMost(this.handle, this.maxBytes, this.label)
    const after = await this.handle.stat({ bigint: true })
    if (!unchangedDuringRead(before, after)) {
      throw new OwnerSecretFileError(
        'owner-secret.file-changed',
        `${this.label} changed while it was being read.`,
      )
    }

    this.value = decodeOneLine(bytes, this.label)
    return this.value
  }

  async consume(): Promise<void> {
    await this.removeMatchingPath()
    await this.close()
  }
}

export class NewOwnerSecretFile extends OwnerSecretDescriptor {
  private written = false

  constructor(
    handle: FileHandle,
    path: string,
    label: string,
    uid: bigint,
    identity: FileIdentity,
    private readonly maxBytes: number,
  ) {
    super(handle, path, label, uid, identity)
  }

  async writeSecret(value: string): Promise<void> {
    this.assertOpen()
    if (this.written) {
      throw new OwnerSecretFileError(
        'owner-secret.already-written',
        `${this.label} has already been written.`,
      )
    }

    const bytes = encodeOneLine(value, this.label, this.maxBytes)
    await writeAll(this.handle, bytes)
    await this.handle.sync()
    const metadata = await this.handle.stat({ bigint: true })
    validateFileMetadata(metadata, this.uid, this.label)
    if (
      !sameIdentity(this.identity, metadata) ||
      metadata.size !== BigInt(bytes.byteLength)
    ) {
      throw new OwnerSecretFileError(
        'owner-secret.file-changed',
        `${this.label} changed while it was being written.`,
      )
    }
    this.written = true
  }

  async discard(): Promise<void> {
    await this.removeMatchingPath()
    await this.close()
  }
}

export async function openOwnerSecretFile(
  options: OwnerSecretFileOptions,
): Promise<OpenedOwnerSecretFile> {
  validateMaxBytes(options.maxBytes)
  const uid = effectiveUid()
  const path = await canonicalOwnerPath(options.path, options.label, uid)
  let handle: FileHandle
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new OwnerSecretFileError(
        'owner-secret.file-type-invalid',
        `${options.label} must be a regular file, not a link or special file.`,
      )
    }
    throw error
  }

  try {
    const metadata = await handle.stat({ bigint: true })
    validateFileMetadata(metadata, uid, options.label)
    validateFileSize(metadata, options.maxBytes, options.label)
    return new OpenedOwnerSecretFile(
      handle,
      path,
      options.label,
      uid,
      { device: metadata.dev, inode: metadata.ino },
      options.maxBytes,
    )
  } catch (error) {
    await handle.close()
    throw error
  }
}

export async function createOwnerSecretFile(
  options: OwnerSecretFileOptions,
): Promise<NewOwnerSecretFile> {
  validateMaxBytes(options.maxBytes)
  const uid = effectiveUid()
  const path = await canonicalOwnerPath(options.path, options.label, uid)
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  )

  try {
    await handle.chmod(0o600)
    const metadata = await handle.stat({ bigint: true })
    validateFileMetadata(metadata, uid, options.label)
    return new NewOwnerSecretFile(
      handle,
      path,
      options.label,
      uid,
      { device: metadata.dev, inode: metadata.ino },
      options.maxBytes,
    )
  } catch (error) {
    await handle.close()
    throw error
  }
}
