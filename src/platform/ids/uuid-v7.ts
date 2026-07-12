import { randomBytes } from 'node:crypto'

const maxTimestamp = 0xffffffffffff

export function newUuidV7(
  timestampMs = Date.now(),
  entropy: Uint8Array = randomBytes(10),
): string {
  if (!Number.isInteger(timestampMs) || timestampMs < 0 || timestampMs > maxTimestamp) {
    throw new RangeError('UUIDv7 timestamp must be an integer in the 48-bit range.')
  }

  if (entropy.length !== 10) {
    throw new RangeError('UUIDv7 requires exactly 10 bytes of entropy.')
  }

  const bytes = new Uint8Array(16)
  let remainingTimestamp = timestampMs

  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = remainingTimestamp & 0xff
    remainingTimestamp = Math.floor(remainingTimestamp / 256)
  }

  bytes[6] = 0x70 | (entropy[0] & 0x0f)
  bytes[7] = entropy[1]
  bytes[8] = 0x80 | (entropy[2] & 0x3f)
  bytes.set(entropy.slice(3), 9)

  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
