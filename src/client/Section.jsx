/**
 * The management section that lives on the Settings page: the credential list,
 * an add form, an inline editor, and delete. Every write goes through the
 * `secretManager` Remote namespace, and every response is the fresh list — one
 * round trip per action.
 *
 * The LIST shows each credential's Chinese label only; the environment-variable
 * name is the tooltip and the editor's first field. Labels are stored beside the
 * store (see `src/host/notes-file.js`) and fall back to a derived description.
 *
 * The value inputs are write-only by construction: there is no read path that
 * returns a stored secret, so nothing here can display one.
 */

import { describeRef } from '../shared/notes.js'
import * as React from 'react'

/** Unwrap a RemoteResult, returning the value or throwing the remote failure. */
function unwrap(result) {
  if (result !== null && typeof result === 'object' && result.ok === true) return result.value
  const failure = result !== null && typeof result === 'object' ? result.error : undefined
  throw new Error(failure?.message ?? failure?.code ?? 'Remote call failed')
}

/** One value-free status badge for a row. */
function badgeFor(row, t) {
  if (row.writable === false) return { className: 'ds-badge is-warn', label: t('badge.readonly') }
  if (row.configured === true) return { className: 'ds-badge is-ok', label: t('badge.configured') }
  return { className: 'ds-badge', label: t('badge.missing') }
}

/** The Chinese label shown in place of the name, with the name as the fallback. */
function labelFor(row) {
  const note = typeof row.note === 'string' && row.note !== '' ? row.note : describeRef(row.name)
  return note === '' ? row.name : note
}

/**
 * Render the Settings-page section.
 * @param props - the section's injected namespace accessor and its translator.
 */
export function Section({ getManager, t }) {
  const [rows, setRows] = React.useState(null)
  const [error, setError] = React.useState('')
  const [notice, setNotice] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [newName, setNewName] = React.useState('')
  const [newNote, setNewNote] = React.useState('')
  const [newValue, setNewValue] = React.useState('')
  const [editing, setEditing] = React.useState(null)
  const nameRef = React.useRef(null)

  /** Run one remote call, folding failures into the notice row. */
  const run = React.useCallback(async (call) => {
    setError('')
    setNotice('')
    const manager = getManager()
    if (manager === undefined) {
      setError(t('error.offline'))
      return false
    }
    setBusy(true)
    try {
      setRows(unwrap(await call(manager)).refs)
      return true
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
      return false
    } finally {
      setBusy(false)
    }
  }, [getManager, t])

  React.useEffect(() => {
    void run(manager => manager.list())
    if (nameRef.current !== null) nameRef.current.focus()
  }, [run])

  const add = async () => {
    const name = newName.trim()
    if (name.length === 0 || newValue.length === 0) return
    const note = newNote.trim()
    if (await run(manager => manager.set(name, newValue, note))) {
      setNewName('')
      setNewNote('')
      setNewValue('')
      setNotice(t('saved'))
    }
  }

  const startEdit = row => setEditing({
    name: row.name,
    nextName: row.name,
    note: typeof row.note === 'string' ? row.note : '',
    value: '',
  })

  const saveEdit = async () => {
    if (editing === null) return
    const next = editing.nextName.trim()
    if (next.length === 0) return
    const note = editing.note.trim()
    const value = editing.value
    const ok = await run(async (manager) => {
      const renamed = next === editing.name ? await manager.list() : await manager.rename(editing.name, next)
      // A blank value means "name/label only" — the stored secret is untouched.
      return value.length > 0 ? await manager.set(next, value, note) : await manager.setNote(next, note)
    })
    if (ok) {
      setEditing(null)
      setNotice(t('saved'))
    }
  }

  const unset = async (name) => {
    if (await run(manager => manager.unset(name))) setNotice(t('removed'))
  }

  const submitOnEnter = event => { if (event.key === 'Enter') void add() }
  const editOnEnter = event => { if (event.key === 'Enter') void saveEdit() }

  return (
    <section className="ds-section" aria-label={t('title')}>
      <header className="ds-section-head">
        <h2>{t('title')}</h2>
        <p className="ds-hint">{t('subtitle')}</p>
      </header>

      {error !== '' && <p className="ds-notice is-error" role="alert">{error}</p>}
      {notice !== '' && error === '' && <p className="ds-notice is-ok">{notice}</p>}
      <p className="ds-hint">{t('hint')}</p>

      {rows === null
        ? <p className="ds-hint">{t('loading')}</p>
        : rows.length === 0
          ? <p className="ds-hint">{t('empty')}</p>
          : <ul className="ds-list">
            {rows.map((row) => {
              const badge = badgeFor(row, t)
              return (
                <li className="ds-row" key={row.name}>
                  <span className="ds-name" title={row.name}>{labelFor(row)}</span>
                  <span className="ds-meta"><span className={badge.className}>{badge.label}</span></span>
                  <span className="ds-actions">
                    <button type="button" className="ds-btn" onClick={() => startEdit(row)}>{t('change')}</button>
                    <button type="button" className="ds-btn" onClick={() => void unset(row.name)}>{t('remove')}</button>
                  </span>
                  {editing !== null && editing.name === row.name && (
                    <div className="ds-edit">
                      <div className="ds-field">
                        <label htmlFor="ds-edit-name">{t('field.name')}</label>
                        <input
                          id="ds-edit-name"
                          className="ds-input is-mono"
                          type="text"
                          spellCheck={false}
                          autoComplete="off"
                          value={editing.nextName}
                          onChange={event => setEditing({ ...editing, nextName: event.target.value })}
                        />
                      </div>
                      <div className="ds-field">
                        <label htmlFor="ds-edit-note">{t('field.note')}</label>
                        <input
                          id="ds-edit-note"
                          className="ds-input"
                          type="text"
                          placeholder={t('field.notePlaceholder')}
                          value={editing.note}
                          onChange={event => setEditing({ ...editing, note: event.target.value })}
                        />
                      </div>
                      <div className="ds-field">
                        <label htmlFor="ds-edit-value">{t('field.valueKeep')}</label>
                        <input
                          id="ds-edit-value"
                          className="ds-input"
                          type="password"
                          autoComplete="new-password"
                          aria-label={`${t('field.value')} · ${row.name}`}
                          placeholder={t('field.valuePlaceholder')}
                          value={editing.value}
                          onChange={event => setEditing({ ...editing, value: event.target.value })}
                          onKeyDown={editOnEnter}
                        />
                      </div>
                      <div className="ds-edit-actions">
                        <button type="button" className="ds-btn is-primary" disabled={busy || editing.nextName.trim().length === 0} onClick={() => void saveEdit()}>
                          {t('save')}
                        </button>
                        <button type="button" className="ds-btn" onClick={() => setEditing(null)}>{t('cancel')}</button>
                      </div>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>}

      <section className="ds-add">
        <h3>{t('add.title')}</h3>
        <div className="ds-fields">
          <div className="ds-field">
            <label htmlFor="ds-new-name">{t('field.name')}</label>
            <input
              id="ds-new-name"
              ref={nameRef}
              className="ds-input is-mono"
              type="text"
              spellCheck={false}
              autoComplete="off"
              placeholder={t('field.namePlaceholder')}
              value={newName}
              onChange={event => setNewName(event.target.value)}
            />
          </div>
          <div className="ds-field">
            <label htmlFor="ds-new-note">{t('field.note')}</label>
            <input
              id="ds-new-note"
              className="ds-input"
              type="text"
              placeholder={t('field.notePlaceholder')}
              value={newNote}
              onChange={event => setNewNote(event.target.value)}
            />
          </div>
          <div className="ds-field">
            <label htmlFor="ds-new-value">{t('field.value')}</label>
            <input
              id="ds-new-value"
              className="ds-input"
              type="password"
              autoComplete="new-password"
              placeholder={t('field.valuePlaceholder')}
              value={newValue}
              onChange={event => setNewValue(event.target.value)}
              onKeyDown={submitOnEnter}
            />
          </div>
          <button
            type="button"
            className="ds-btn is-primary"
            disabled={busy || newName.trim().length === 0 || newValue.length === 0}
            onClick={() => void add()}
          >{t('save')}</button>
        </div>
      </section>

      <footer className="ds-foot">{t('note')}</footer>
    </section>
  )
}
