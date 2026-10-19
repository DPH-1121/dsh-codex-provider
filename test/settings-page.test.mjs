// What does the Settings -> Models page actually derive from what this plugin
// registers?
//
// The plugin contributes a configurable-provider directory entry and a settings
// namespace. Those two are what the models page reads to draw a row, so this
// checks the *shape* it will receive — in particular under the fallback-route
// case, where another adapter already owns `codex` and this plugin serves
// `codex-provider` instead. A row registered under a route the page cannot
// reconcile with the served route is the failure mode worth ruling out.
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import * as plugin from '../lib/index.js'
import { MemorySettings } from './memory-settings.mjs'

let passed = 0
let failed = 0
async function check(name, fn) {
  try {
    await fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (error) {
    failed++
    console.log(`FAIL  ${name}\n      ${error.message}`)
  }
}

/** Mount the plugin and hand back the live registries. */
async function mount(options = {}) {
  const ctx = new Context()
  ctx.plugin(LlmRuntime)
  ctx.plugin(MemorySettings)
  await new Promise((r) => setTimeout(r, 200))

  // An impostor adapter that has already claimed `codex`, to force the fallback.
  // It extends the real base class, because the registry calls more of the
  // contract than `stream()` — a hand-rolled stub is rejected outright.
  if (options.codexTaken === true) {
    class Impostor extends LlmAdapter {
      providerInfo(id) { return { id, name: 'Impostor' } }
      async listModels() { return [] }
      async resolveModel(_p, model) { return { provider: 'codex', id: model, name: model } }
      async *stream() {}
    }
    ctx.llm.registerAdapter(['codex'], new Impostor())
  }

  ctx.plugin({ inject: ['llm'], apply: (inner) => plugin.apply(inner, {}) })
  await new Promise((r) => setTimeout(r, 350))
  return ctx
}

console.log('settings/models page surface')

const ctx = await mount()

await check('the directory entry names a route that is actually registered', () => {
  const served = new Set(ctx.llm.listProviders().map((p) => p.id))
  const declared = ctx.llm.listConfigurableProviders()
  if (declared.length === 0) throw new Error('no configurable provider was declared')
  for (const entry of declared) {
    if (!served.has(entry.provider)) {
      throw new Error(`directory declares "${entry.provider}" but the registered routes are ${[...served].join(', ')}`)
    }
  }
})

await check('the directory entry carries the metadata a row needs', () => {
  const entry = ctx.llm.listConfigurableProviders()[0]
  for (const field of ['provider', 'displayName', 'settingsNs']) {
    if (typeof entry[field] !== 'string' || entry[field].length === 0) {
      throw new Error(`directory entry is missing ${field}`)
    }
  }
  if (!Array.isArray(entry.settingsPath)) throw new Error('settingsPath must be an array')
  if (entry.error !== undefined) throw new Error(`directory entry carries an error: ${entry.error}`)
})

await check('the declared namespace resolves to a schema-valid section', () => {
  const entry = ctx.llm.listConfigurableProviders()[0]
  const resolved = ctx.get('settings').get(entry.settingsNs)
  if (resolved === undefined) throw new Error(`namespace ${entry.settingsNs} did not resolve`)
  // The page reads fields off this object to render controls.
  for (const field of ['enabled', 'baseURL', 'refreshMinutes', 'clientVersion']) {
    if (resolved[field] === undefined) throw new Error(`resolved section is missing ${field}`)
  }
})

await check('no settings namespace is left unregistered after a duplicate discovery', () => {
  const namespaces = ctx.get('settings').describe().map((d) => d.ns)
  if (!namespaces.includes('llm-codex')) throw new Error(`namespaces were ${JSON.stringify(namespaces)}`)
})

console.log('\nfallback route (another adapter already owns "codex")')

const ctx2 = await mount({ codexTaken: true })

await check('the plugin serves the fallback route instead of failing', () => {
  const ids = ctx2.llm.listProviders().map((p) => p.id)
  if (!ids.includes('codex-provider')) throw new Error(`routes were ${JSON.stringify(ids)}; expected codex-provider`)
})

await check('the directory row follows the route actually served', () => {
  const entry = ctx2.llm.listConfigurableProviders()[0]
  if (entry === undefined) throw new Error('no directory entry was declared')
  if (entry.provider !== 'codex-provider') {
    throw new Error(`directory declares "${entry.provider}" but the plugin serves "codex-provider"`)
  }
  // The impostor must be untouched.
  const impostor = ctx2.llm.listProviders().find((p) => p.id === 'codex')
  if (impostor?.name !== 'Impostor') throw new Error('the plugin clobbered the existing codex route')
})

await check('the settings namespace still installs under the fallback route', () => {
  const namespaces = ctx2.get('settings').describe().map((d) => d.ns)
  if (!namespaces.includes('llm-codex')) throw new Error(`namespaces were ${JSON.stringify(namespaces)}`)
})

await check('the fallback route is usable, not just registered', async () => {
  const models = await ctx2.llm.listModels('codex-provider')
  if (models.length === 0) throw new Error('the fallback route served no models')
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
