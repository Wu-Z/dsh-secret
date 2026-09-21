/**
 * One injected stylesheet for the whole plugin.
 *
 * Class-based rather than inline so hover, focus and transitions work; colors
 * come from harness theme tokens only, so light and dark mode are both covered
 * without a second rule set.
 *
 * This sheet styles the Settings-page section and nothing else: it deliberately
 * contains no selector for harness-owned chrome (the sidebar, the layout), so
 * loading or removing the plugin cannot disturb another surface.
 */

/** Stable identifier used for the injection guard. */
export const CSS_ID = 'dsh-secret/client.css'

export const CSS = `
.ds-section { display: flex; flex-direction: column; gap: 10px; }
.ds-section-head h2 { margin: 0 0 4px; font-size: 13px; font-weight: 600; }
.ds-section-head .ds-hint { margin: 0; }
.ds-hint { margin: 0 0 12px; color: var(--dsw-alias-label-tertiary, #9a9a94); font-size: 12px; line-height: 1.6; }
.ds-notice { margin: 0 0 12px; padding: 8px 10px; border-radius: 6px; font-size: 12px; }
.ds-notice.is-error { background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #d33) 12%, transparent); color: var(--dsw-alias-state-error-primary, #d33); }
.ds-notice.is-ok { background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #2f7d4f) 12%, transparent); color: var(--dsw-alias-state-success-primary, #2f7d4f); }
.ds-list { display: flex; flex-direction: column; gap: 2px; margin: 0 0 14px; padding: 0; list-style: none; }
.ds-row {
  display: grid; grid-template-columns: 1fr auto auto; align-items: center; gap: 10px;
  padding: 8px 10px; border-radius: 6px;
}
.ds-row:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.04)); }
.ds-name { font-size: 13px; overflow-wrap: anywhere; }
.ds-meta { display: flex; align-items: center; gap: 8px; }
.ds-badge { font-size: 11px; padding: 1px 6px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.14)); color: var(--dsw-alias-label-tertiary, #9a9a94); }
.ds-badge.is-ok { color: var(--dsw-alias-state-success-primary, #2f7d4f); border-color: currentColor; }
.ds-badge.is-warn { color: var(--dsw-alias-state-warn-primary, #a8842c); border-color: currentColor; }
.ds-actions { display: flex; gap: 6px; }
.ds-btn {
  border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.14)); border-radius: 6px;
  background: var(--dsw-alias-bg-layer-2, transparent); color: var(--dsw-alias-label-primary, #141414);
  padding: 4px 10px; cursor: pointer; font: inherit; font-size: 12px;
}
.ds-btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05)); }
.ds-btn:disabled { opacity: .5; cursor: default; }
.ds-btn.is-primary { background: var(--dsw-alias-brand-primary, #2563eb); border-color: transparent; color: var(--dsw-alias-label-primary-inverted, #fff); }
.ds-edit { display: flex; flex-direction: column; gap: 8px; align-items: stretch; grid-column: 1 / -1; padding-top: 6px; }
.ds-edit-actions { display: flex; gap: 6px; grid-column: 1 / -1; justify-content: flex-end; }
.ds-add { border-top: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1)); padding-top: 12px; }
.ds-add h3 { margin: 0 0 8px; font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary, #6b6b6b); }
/* 每个填充项各占一行（按列排），标签在上、输入占满整行 */
.ds-fields { display: flex; flex-direction: column; gap: 8px; align-items: stretch; }
.ds-fields > .ds-btn { align-self: flex-end; }
.ds-field { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.ds-field label { font-size: 11px; color: var(--dsw-alias-label-tertiary, #9a9a94); }
.ds-input {
  border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.16)); border-radius: 6px;
  background: var(--dsw-alias-bg-layer-2, transparent); color: inherit;
  padding: 6px 8px; font: inherit; font-size: 12px; box-sizing: border-box; width: 100%;
}
.ds-input.is-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.ds-input:focus-visible { outline: none; border-color: var(--dsw-alias-brand-primary, #2563eb); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-brand-primary, #2563eb) 18%, transparent); }
.ds-foot { color: var(--dsw-alias-label-tertiary, #9a9a94); font-size: 11px; line-height: 1.6; }
`

/**
 * Append the stylesheet once.
 * @returns the style element, or undefined when a document is unavailable.
 */
export function injectStyles() {
  if (typeof document === 'undefined') return undefined
  if (document.querySelector(`style[data-dsh-css="${CSS_ID}"]`) !== null) return undefined
  const element = document.createElement('style')
  element.dataset.dshCss = CSS_ID
  element.textContent = CSS
  document.head.appendChild(element)
  return element
}
