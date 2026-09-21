/**
 * The Chinese labels that sit beside credential names.
 *
 * They live in their own YAML file (`~/.dsh/.credentials-notes.yaml` by
 * default) rather than in the credential store, because the store belongs to
 * the harness and is strictly `name: value`. A sidecar keeps this plugin's
 * vocabulary out of a file another component owns — and stays hand-editable:
 *
 *   notes:
 *     OPENAI_API_KEY: OpenAI 平台密钥
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { assertEditable, deleteRef, parseRefNames, setRefValue, storePath } from '../../store-edit.mjs'

const HEADER = '# dsh-secret：凭据的中文说明（键是凭据名，值是说明文字；这里不含任何密码）\nversion: 1\n'

/** Undo `quoteScalar`'s single-quoted form (and tolerate unquoted text). */
function unquoteScalar(raw) {
  const text = raw.trim()
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replace(/''/g, "'")
  }
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) return text.slice(1, -1)
  return text
}

/**
 * Where the labels live for one composition.
 *
 * @param options - resolved plugin options (`path`, `notesPath`).
 * @returns the absolute notes-file path.
 */
export function notesPathOf(options) {
  if (typeof options?.notesPath === 'string' && options.notesPath.length > 0) return options.notesPath
  return join(dirname(storePath(options ?? {})), '.credentials-notes.yaml')
}

/**
 * Read every stored label.
 *
 * @param path - the notes-file path.
 * @returns name → label, empty when the file is absent.
 */
export async function readNotes(path) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return new Map()
    throw error
  }
  const notes = new Map()
  let inNotes = false
  for (const line of text.split(/\r?\n/)) {
    if (!inNotes) {
      if (/^notes:\s*$/.test(line)) inNotes = true
      continue
    }
    if (/^\S/.test(line)) break
    if (/^\s*$/.test(line) || /^\s*#/.test(line)) continue
    const match = /^ {2}([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line)
    if (match !== null) notes.set(match[1], unquoteScalar(match[2]))
  }
  return notes
}

/** Read-modify-write the notes file atomically (0600, temp file + rename). */
async function mutate(path, change) {
  let text = ''
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  if (text.trim() === '') text = HEADER
  assertEditable(text)
  const next = change(text)
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${String(process.pid)}`
  await writeFile(temporary, next, { mode: 0o600 })
  await rename(temporary, path)
}

/**
 * Store, replace, or clear one label.
 *
 * @param path - the notes-file path.
 * @param ref - credential name.
 * @param note - the label; `''` removes it.
 */
export async function writeNote(path, ref, note) {
  await mutate(path, (current) => {
    if (note === '') return current.includes('notes:') ? deleteRef(current, ref, 'notes').text : current
    // `setRefValue` creates the `notes:` section itself when it is absent.
    return setRefValue(current, ref, note, 'notes')
  })
}

/**
 * Move a label to a new name.
 *
 * @param path - the notes-file path.
 * @param from - current credential name.
 * @param to - new credential name.
 */
export async function renameNote(path, from, to) {
  const notes = await readNotes(path)
  if (!notes.has(from)) return
  const label = notes.get(from)
  await mutate(path, current => setRefValue(deleteRef(current, from, 'notes').text, to, label, 'notes'))
}

/**
 * Drop a label.
 *
 * @param path - the notes-file path.
 * @param ref - credential name.
 */
export async function deleteNote(path, ref) {
  const notes = await readNotes(path)
  if (!notes.has(ref)) return
  await mutate(path, current => deleteRef(current, ref, 'notes').text)
}

/** The names present in the notes file (used by tests and diagnostics). */
export { parseRefNames }
