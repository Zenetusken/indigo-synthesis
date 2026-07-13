import { createHash } from 'node:crypto'
import { open, realpath } from 'node:fs/promises'

export type StableFileIdentity = {
  readonly realpath: string
  readonly device: string
  readonly inode: string
  readonly sizeBytes: number
  readonly mtimeMs: number
  readonly sha256: string
}

type StableMetadata = {
  readonly device: bigint
  readonly inode: bigint
  readonly sizeBytes: bigint
  readonly mtimeMs: bigint
}

function stableMetadata(metadata: {
  readonly dev: bigint
  readonly ino: bigint
  readonly size: bigint
  readonly mtimeMs: bigint
}): StableMetadata {
  return {
    device: metadata.dev,
    inode: metadata.ino,
    sizeBytes: metadata.size,
    mtimeMs: metadata.mtimeMs,
  }
}

function sameMetadata(left: StableMetadata, right: StableMetadata): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.sizeBytes === right.sizeBytes &&
    left.mtimeMs === right.mtimeMs
  )
}

function identityMetadata(identity: StableFileIdentity): StableMetadata {
  return {
    device: BigInt(identity.device),
    inode: BigInt(identity.inode),
    sizeBytes: BigInt(identity.sizeBytes),
    mtimeMs: BigInt(identity.mtimeMs),
  }
}

export async function assertStableFileIdentity(
  path: string,
  identity: StableFileIdentity,
  label: string,
): Promise<void> {
  const handle = await open(path, 'r')
  try {
    const [currentRealpath, currentStat] = await Promise.all([
      realpath(`/proc/self/fd/${handle.fd}`),
      handle.stat({ bigint: true }),
    ])
    if (
      !currentStat.isFile() ||
      currentRealpath !== identity.realpath ||
      !sameMetadata(stableMetadata(currentStat), identityMetadata(identity))
    ) {
      throw new Error(`${label} path no longer identifies the file that was hashed`)
    }
  } finally {
    await handle.close()
  }
}

export async function hashStableFileIdentity(
  path: string,
  label: string,
): Promise<StableFileIdentity> {
  const handle = await open(path, 'r')
  try {
    const [canonicalPath, beforeStat] = await Promise.all([
      realpath(`/proc/self/fd/${handle.fd}`),
      handle.stat({ bigint: true }),
    ])
    if (!beforeStat.isFile()) {
      throw new Error(`${label} is not a regular file`)
    }
    const before = stableMetadata(beforeStat)
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    let position = 0
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
      if (bytesRead === 0) break
      hash.update(buffer.subarray(0, bytesRead))
      position += bytesRead
    }

    const afterStat = await handle.stat({ bigint: true })
    const after = stableMetadata(afterStat)
    if (!sameMetadata(before, after)) {
      throw new Error(`${label} changed while it was being hashed`)
    }
    const identity: StableFileIdentity = {
      realpath: canonicalPath,
      device: after.device.toString(10),
      inode: after.inode.toString(10),
      sizeBytes: Number(after.sizeBytes),
      mtimeMs: Number(after.mtimeMs),
      sha256: hash.digest('hex'),
    }
    await assertStableFileIdentity(path, identity, label)
    return identity
  } finally {
    await handle.close()
  }
}
