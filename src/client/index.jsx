/** Browser half: mount the Remote namespace and the Settings-page section. */

import * as React from 'react'
import { Section } from './Section.jsx'
import { en, NS, zh } from './locales.js'
import { REMOTE_CONTRIBUTION } from './remote.js'
import { injectStyles } from './styles.js'

/** Services required before the Settings seat can register. */
export const inject = ['slots', 'locale', 'remote']

/**
 * Mount the plugin's browser surfaces.
 * @param ctx - client plugin context.
 */
async function mount(ctx) {
  injectStyles()
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-secret: dictionaries')

  const remote = ctx.remote
  if (remote !== undefined && typeof remote.$mount === 'function') {
    const dispose = await remote.$mount(REMOTE_CONTRIBUTION)
    ctx.effect(() => () => { dispose() }, 'dsh-secret: remote contribution')
  }

  // `ctx.locale.bind(NS)` is what the in-repo Settings sections use to label
  // their navigation entry, so the section is named in the user's language.
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'dsh-secret',
    order: 30,
    label: () => t('nav'),
    locale: NS,
    // Resolved per call: the namespace arrives with the mount above.
    inject: () => ({ getManager: () => ctx.get('remote.secretManager') }),
  }, Section))
}

/**
 * Mount the plugin's browser surfaces, containing any failure.
 *
 * A client plugin that throws while the browser boots can take the whole Web UI
 * down with it. This plugin is a personal convenience, so a failure here leaves
 * the section unmounted and the reason in the browser console.
 * @param ctx - client plugin context.
 */
export async function apply(ctx) {
  try {
    await mount(ctx)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    try {
      console.error('dsh-secret: client activation failed, mounting a diagnostic instead', error)
    } catch {
      // Logging must not resurrect the failure it is reporting.
    }
    // A silent catch would leave the user staring at a missing section with no
    // way to report why. Register a visible surrogate that SHOWS the reason.
    try {
      injectStyles()
      mountDiagnostic(ctx, message)
    } catch {
      // Nothing left to try: the slot itself is unavailable.
    }
  }
}

/**
 * The last-resort section: it shows why the real one is missing.
 * @param ctx - client plugin context.
 * @param message - the activation failure.
 */
function mountDiagnostic(ctx, message) {
  const Diagnostic = () => (
    <section className="ds-section">
      <header className="ds-section-head"><h2>密码管理未挂载</h2></header>
      <p className="ds-notice is-error">{message}</p>
      <p className="ds-hint">把这条信息发给助手即可定位。</p>
    </section>
  )
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'dsh-secret-diagnostic',
    order: 31,
    label: () => '密码管理（未挂载）',
  }, Diagnostic))
}
