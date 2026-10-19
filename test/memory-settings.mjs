import { Service } from '@deepseek-ai/cordis'

function merge(base, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return structuredClone(patch)
  const out = base !== null && typeof base === 'object' && !Array.isArray(base)
    ? structuredClone(base)
    : {}
  for (const [key, value] of Object.entries(patch)) {
    out[key] = key in out ? merge(out[key], value) : structuredClone(value)
  }
  return out
}

/** Minimal pre-0.2 SettingsProvider seam used by the plugin's compatibility tests. */
export class MemorySettings extends Service {
  constructor(ctx) {
    super(ctx, 'settings')
    this.registrations = new Map()
  }

  installSection(_owner, ns, _schema, entry, hooks) {
    const registration = { base: structuredClone(entry), section: {}, hooks }
    this.registrations.set(ns, registration)
    hooks.setSource(() => this.get(ns))
    hooks.onChange()
  }

  get(ns) {
    const registration = this.registrations.get(ns)
    return registration === undefined ? undefined : merge(registration.base, registration.section)
  }

  describe() {
    return [...this.registrations.keys()].map(ns => ({ ns }))
  }

  async update(ns, patch) {
    const registration = this.registrations.get(ns)
    if (registration === undefined) throw new Error(`settings namespace "${ns}" is not registered`)
    registration.section = merge(registration.section, patch)
    registration.hooks.onChange()
  }
}
