// Verify the settings integration: mount the plugin beside a stub settings
// provider and confirm the `llm-codex` namespace installs, validates, and
// feeds resolved values back into the adapter.
import { Context, Service } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
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

const ctx = new Context()
ctx.plugin(LlmRuntime)
ctx.plugin(MemorySettings)
await new Promise((r) => setTimeout(r, 200))

console.log('settings service present:', ctx.get('settings') !== undefined)

ctx.plugin({
  inject: ['llm'],
  apply(inner) {
    plugin.apply(inner, { refreshMinutes: 7 })
  },
})
await new Promise((r) => setTimeout(r, 300))

const settings = ctx.get('settings')

await check('the llm-codex namespace is installed', () => {
  const namespaces = settings.describe().map((d) => d.ns)
  if (!namespaces.includes('llm-codex')) throw new Error(`namespaces were ${JSON.stringify(namespaces)}`)
})

await check('the composition entry is the resolved base', () => {
  const resolved = settings.get('llm-codex')
  if (resolved === undefined) throw new Error('namespace resolved to undefined')
  if (resolved.refreshMinutes !== 7) throw new Error(`refreshMinutes was ${resolved.refreshMinutes}`)
})

await check('a stored patch overrides the base field by field', async () => {
  await settings.update('llm-codex', { refreshMinutes: 11 })
  const resolved = settings.get('llm-codex')
  if (resolved.refreshMinutes !== 11) throw new Error(`refreshMinutes was ${resolved.refreshMinutes}`)
  // Untouched fields keep their base value.
  if (resolved.enabled !== true) throw new Error('enabled was disturbed by an unrelated patch')
})

await check('the provider still resolves the service list', () => {
  const providers = ctx.llm.listProviders().map((p) => p.id)
  if (!providers.includes('codex')) throw new Error(`providers were ${JSON.stringify(providers)}`)
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
