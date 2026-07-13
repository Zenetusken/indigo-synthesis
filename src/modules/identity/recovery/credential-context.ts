import { minimizeCredentialClientAddress } from '../infrastructure/client-address'

export type WebCredentialContext = {
  readonly channel: 'web'
  readonly clientAddress: string
}

export type HostCredentialContext = {
  readonly channel: 'host-local-cli'
}

export type CredentialContext = WebCredentialContext | HostCredentialContext

export function credentialAuditContext(context: CredentialContext) {
  return context.channel === 'web'
    ? {
        channel: context.channel,
        clientAddress: minimizeCredentialClientAddress(context.clientAddress),
      }
    : { channel: context.channel }
}
