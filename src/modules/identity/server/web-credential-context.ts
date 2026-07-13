import { headers } from 'next/headers'
import { getServerConfig } from '@/platform/config/server'
import { resolveWebClientAddress } from '../infrastructure/client-address'
import type { WebCredentialContext } from '../recovery/credential-context'

export async function getWebCredentialContext(): Promise<WebCredentialContext | null> {
  const config = getServerConfig()
  const clientAddress = resolveWebClientAddress(await headers(), {
    allowDirectLoopback: !config.secureCookies,
  })
  return clientAddress ? { channel: 'web', clientAddress } : null
}
