const overrides: Readonly<Record<string, string>> = {
  authAccounts: 'Local credentials',
  authVerifications: 'Verification tokens',
  destructiveReauthenticationStates: 'Re-authentication challenges',
  installationStates: 'Installation records',
  deletionPlans: 'Deletion previews',
  auditEvents: 'Audit events',
  contentReleaseRevocations: 'Content-release revocations',
}

/**
 * Turns a deletion-plan count key (e.g. `programRevisionInvalidations`) into a
 * human-readable category label for the destructive preview screens. Falls back
 * to sentence-casing the camelCase key so a new table never renders as raw code.
 */
export function deletionCategoryLabel(key: string): string {
  if (key in overrides) return overrides[key]
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}
