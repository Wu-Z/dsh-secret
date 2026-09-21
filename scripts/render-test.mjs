/**
 * Render-layer test for the browser bundle.
 *
 * Loads the built `lib/client.js`, runs its `apply` against a stub client
 * context, then server-renders the registered component in every state the
 * panel can be in. React's hooks are stubbed with a seed queue so a single
 * render pass can be driven into each state without a browser; `createPortal`
 * renders inline so the panel body is actually exercised. Not shipped.
 */

import { renderToStaticMarkup } from 'react-dom/server'
import * as React from 'react'
import * as ReactDom from 'react-dom'

const SECRET = 'hunter2-hunter2'
const ROWS = [
  { name: 'DB_PASSWORD', configured: true, source: 'file', writable: true },
  { name: 'GATEWAY_API_KEY', configured: true, source: 'env', writable: false },
  { name: 'MOONSHOT_API_KEY', configured: false, writable: true },
]

const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail.length > 0 ? ` — ${detail}` : ''}\n`)
}

/* ------------------------------------------------ capture the registration */

let registration = null
const injected = []
globalThis.document = {
  querySelector: () => null,
  createElement: () => ({ dataset: {}, textContent: '' }),
  head: { appendChild: element => injected.push(element) },
}
globalThis.window = {
  __ModuleLoader__: { load: value => { registration = value } },
  addEventListener: () => {},
  removeEventListener: () => {},
}

await import('../lib/client.js')
check('bundle registers as dsh-secret', registration !== null && registration.id === 'dsh-secret')

/* --------------------------------------------------------- stub the externals */

/** Seeds consumed in hook-call order, so one pass reaches any state. */
let seeds = []
const reactStub = {
  ...React,
  useState: initial => [seeds.length > 0 ? seeds.shift() : initial, () => {}],
  useEffect: () => {},
  useCallback: callback => callback,
  useRef: () => ({ current: null }),
}

const requireStub = (spec) => {
  if (spec === 'react') return reactStub
  if (spec === 'react-dom') return { ...ReactDom, createPortal: node => node }
  throw new Error(`unexpected external in the browser bundle: ${spec}`)
}

const exported = registration.factory(requireStub)
check('bundle exports apply + inject', typeof exported.apply === 'function' && Array.isArray(exported.inject),
  `inject=${JSON.stringify(exported.inject)}`)

/* ------------------------------------------------------------ run the plugin */

const manager = {
  list: async () => ({ ok: true, value: { refs: ROWS } }),
  set: async () => ({ ok: true, value: { refs: ROWS } }),
  unset: async () => ({ ok: true, value: { refs: ROWS } }),
}

let slot = null
const registrations = []
const ctx = {
  effect: (fn) => { if (typeof fn === 'function') fn() },
  locale: { register: () => () => {}, bind: () => key => `«${key}»` },
  remote: { $mount: async () => () => {} },
  get: key => (key === 'remote.secretManager' ? manager : undefined),
  slots: {
    inject: (_name, callback) => callback(),
    register: (declaration, component) => {
      if (slot === null) slot = { declaration, component }
      registrations.push({ declaration, component })
      return () => {}
    },
  },
}

await exported.apply(ctx)
check('registers its section into the Settings page', slot !== null
  && slot.declaration.name === 'settings.section'
  && slot.declaration.id === 'dsh-secret'
  && typeof slot.declaration.order === 'number'
  && typeof slot.declaration.label === 'function')
check('injected the plugin stylesheet once', injected.length === 1)
const injectedCss = String(injected[0]?.textContent ?? '')
check('the add form and the editor stack their fields in one column',
  /\.ds-fields \{[^}]*flex-direction: column/.test(injectedCss)
  && /\.ds-edit \{[^}]*flex-direction: column/.test(injectedCss)
  && /\.ds-input \{[^}]*width: 100%/.test(injectedCss))
// Styling harness-owned chrome is how a plugin breaks another surface (an
// earlier revision re-flowed the sidebar foot and clipped the Settings button).
check('the stylesheet never targets harness-owned chrome',
  !injectedCss.includes('_footArea') && !injectedCss.includes('_collapsed')
  && !injectedCss.includes('@container') && !injectedCss.includes('_settingsArea'))

/** Identity translator: assertions below then read the key names. */
const t = key => `«${key}»`
const render = (hookSeeds) => {
  seeds = hookSeeds
  return renderToStaticMarkup(React.createElement(slot.component, { getManager: () => manager, t }))
}

/* ------------------------------------------------------------------ panel */

// Section states: [rows, error, notice, busy, newName, newNote, newValue, editing]
const panel = render([ROWS, '', '', false, '', '', '', null])
check('the section renders inline (no modal chrome of its own)',
  panel.includes('ds-section') && !panel.includes('ds-backdrop') && !panel.includes('role="dialog"'))
check('panel lists every stored name as the tooltip, not as visible text',
  ROWS.every(row => panel.includes(`title="${row.name}"`)) && !panel.includes('>DB_PASSWORD<'))
check('panel shows a Chinese description per recognized name',
  panel.includes('DB 的密码') && panel.includes('API 密钥'))
check('panel badges configured rows', panel.includes('«badge.configured»'))
check('panel badges a value shadowed by the environment', panel.includes('«badge.readonly»'))
check('panel never renders a secret value', !panel.includes(SECRET))
check('panel offers the add form', panel.includes('ds-new-name') && panel.includes('ds-new-value'))
check('value inputs are write-only password fields', panel.includes('type="password"'))
check('panel states the write-only rule', panel.includes('«note»'))

const loading = render([null, '', '', false, '', '', '', null])
check('panel renders its loading state', loading.includes('«loading»'))

const empty = render([[], '', '', false, '', '', '', null])
check('panel renders its empty state', empty.includes('«empty»'))

const failed = render([[], 'boom', '', false, '', '', '', null])
check('panel renders a remote failure', failed.includes('boom') && failed.includes('role="alert"'))

const editing = render([ROWS, '', '', false, '', '', '', { name: 'DB_PASSWORD', nextName: 'DB_PASSWORD', note: 'DB 的密码', value: 'typed' }])
check('editor exposes the name and the label for editing',
  editing.includes('«field.name»') && editing.includes('«field.note»') && editing.includes('«field.valueKeep»'))
check('panel opens an inline editor for one row', editing.includes('ds-edit') && editing.includes('«cancel»'))

/* ------------------------------------------------------------- fail-safe */

const failing = { ...ctx, remote: { $mount: async () => { throw new Error('mount exploded') } } }
let rejected = false
try {
  await exported.apply(failing)
} catch {
  rejected = true
}
check('client apply contains a mount failure instead of rejecting', rejected === false)
check('a failed mount still registers a visible diagnostic button',
  registrations.some(entry => entry.declaration.id === 'dsh-secret-diagnostic'))

/* ------------------------------------------------------------------- report */

process.stdout.write(results.every(Boolean) ? 'RESULT: all passed\n' : 'RESULT: FAILURES\n')
process.exitCode = results.every(Boolean) ? 0 : 1
