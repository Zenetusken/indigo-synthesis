import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  InvalidModelSettingsError,
  type ModelSettings,
  parseModelSettings,
} from './model-settings'

export class ModelRegistryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ModelRegistryError'
  }
}

export type ModelRegistry = ReadonlyMap<string, ModelSettings>

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * Loads every model pack `settings.json` under `modelsDir`. Fails closed on invalid JSON,
 * schema violations, or duplicate modelId values.
 */
export function loadModelRegistry(modelsDir: string): ModelRegistry {
  const absoluteDir = resolve(modelsDir)
  if (!isDirectory(absoluteDir)) {
    throw new ModelRegistryError(
      `Model registry directory does not exist: ${absoluteDir}`,
    )
  }

  const entries = readdirSync(absoluteDir, { withFileTypes: true })
  const packs = new Map<string, ModelSettings>()

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith('.')) continue

    const settingsPath = join(absoluteDir, entry.name, 'settings.json')
    let raw: string
    try {
      raw = readFileSync(settingsPath, 'utf8')
    } catch {
      throw new ModelRegistryError(
        `Missing settings.json for model pack directory: ${entry.name}`,
      )
    }

    let json: unknown
    try {
      json = JSON.parse(raw) as unknown
    } catch {
      throw new ModelRegistryError(`Invalid JSON in ${settingsPath}`)
    }

    let settings: ModelSettings
    try {
      settings = parseModelSettings(json)
    } catch (error) {
      if (error instanceof InvalidModelSettingsError) {
        throw new ModelRegistryError(
          `Invalid settings for pack ${entry.name}: ${error.issues.join('; ')}`,
        )
      }
      throw error
    }

    if (settings.modelId !== entry.name) {
      throw new ModelRegistryError(
        `Pack directory "${entry.name}" must match settings modelId "${settings.modelId}"`,
      )
    }

    if (packs.has(settings.modelId)) {
      throw new ModelRegistryError(`Duplicate modelId in registry: ${settings.modelId}`)
    }

    packs.set(settings.modelId, settings)
  }

  if (packs.size === 0) {
    throw new ModelRegistryError(`No model packs found under ${absoluteDir}`)
  }

  return packs
}

export function requireModelSettings(
  registry: ModelRegistry,
  modelId: string,
): ModelSettings {
  const settings = registry.get(modelId)
  if (!settings) {
    throw new ModelRegistryError(
      `Unknown modelId "${modelId}". Known: ${[...registry.keys()].sort().join(', ')}`,
    )
  }
  return settings
}
