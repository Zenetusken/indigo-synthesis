import {
  InstallationMutationEpoch,
  SubjectDataGeneration,
} from '@/application/coordination'

const lifecycleValuePattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const lifecycleConstructionToken = Object.freeze({})
const installationEpochValues = new WeakMap<object, string>()
const subjectGenerationValues = new WeakMap<object, string>()

class PlatformInstallationMutationEpoch extends InstallationMutationEpoch {
  constructor(token: typeof lifecycleConstructionToken, value: string) {
    super()
    if (token !== lifecycleConstructionToken) {
      throw new TypeError('Installation mutation epoch was not issued by Platform.')
    }
    installationEpochValues.set(this, value)
  }
}

class PlatformSubjectDataGeneration extends SubjectDataGeneration {
  constructor(token: typeof lifecycleConstructionToken, value: string) {
    super()
    if (token !== lifecycleConstructionToken) {
      throw new TypeError('Subject data generation was not issued by Platform.')
    }
    subjectGenerationValues.set(this, value)
  }
}

function installationEpochValue(epoch: InstallationMutationEpoch): string {
  const value = installationEpochValues.get(epoch)
  if (!value) {
    throw new TypeError('Installation mutation epoch was not issued by Platform.')
  }
  return value
}

function subjectGenerationValue(generation: SubjectDataGeneration): string {
  const value = subjectGenerationValues.get(generation)
  if (!value) {
    throw new TypeError('Subject data generation was not issued by Platform.')
  }
  return value
}

function parseLifecycleValue(label: string, raw: unknown): string {
  if (typeof raw !== 'string' || !lifecycleValuePattern.test(raw)) {
    throw new TypeError(`${label} must be a canonical UUIDv4.`)
  }
  return raw
}

export function createInstallationMutationEpoch(raw: unknown): InstallationMutationEpoch {
  return new PlatformInstallationMutationEpoch(
    lifecycleConstructionToken,
    parseLifecycleValue('Installation mutation epoch', raw),
  )
}

export function installationMutationEpochWireValue(
  epoch: InstallationMutationEpoch,
): string {
  return installationEpochValue(epoch)
}

export function installationMutationEpochMatches(
  epoch: InstallationMutationEpoch,
  raw: unknown,
): boolean {
  return typeof raw === 'string' && installationEpochValue(epoch) === raw
}

export function createSubjectDataGeneration(raw: unknown): SubjectDataGeneration {
  return new PlatformSubjectDataGeneration(
    lifecycleConstructionToken,
    parseLifecycleValue('Subject data generation', raw),
  )
}

export function subjectDataGenerationWireValue(
  generation: SubjectDataGeneration,
): string {
  return subjectGenerationValue(generation)
}
