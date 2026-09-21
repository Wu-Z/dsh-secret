/**
 * Pure credential-store document helpers, shared by the host plugin
 * (`index.js`) and the management CLI (`cli.mjs`).
 *
 * Nothing here touches a service, a terminal, or the network: every function
 * takes text and returns text, so the CLI's edit logic is testable without a
 * TTY and the plugin's listing logic is testable without the harness.
 *
 * Edits are line-targeted rather than a re-serialize, so comments, key order,
 * and the formatting of untouched entries survive — the same promise the
 * file-backed credential provider makes about its own writes.
 */

/** POSIX-style reference grammar, the same one the credential seam validates. */
export const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Whether a raw string could name a credential reference.
 *
 * @param value - candidate name.
 * @returns true when the name is addressable in the reference key space.
 */
export function isRefName(value) {
  return typeof value === 'string' && REF_PATTERN.test(value)
}

/**
 * Resolve the credential store document path.
 *
 * `$DSH_HOME/.credentials.yaml` is the provider's default; a composition that
 * mounts `@deepseek-ai/dsh-credentials-local` with an explicit `path` must pass
 * the same value here, because this module cannot see the provider's config.
 *
 * @param config - a `{ path }` override, or undefined for the default.
 * @returns the absolute store path.
 */
export function storePath(config) {
  if (config !== undefined && typeof config.path === 'string' && config.path.length > 0) return config.path
  const home = process.env.DSH_HOME
  if (typeof home === 'string' && home.length > 0) return joinPath(home, '.credentials.yaml')
  return joinPath(process.env.HOME ?? process.env.USERPROFILE ?? '.', '.dsh', '.credentials.yaml')
}

/** Minimal join so this module carries no node:path import for its callers. */
function joinPath(...parts) {
  return parts.join('/').replace(/\/{2,}/g, '/')
}

/**
 * Extract only the KEY NAMES of the top-level `refs:` section.
 *
 * A dependency-free scan rather than a YAML parse: the store document is
 * machine-written in a fixed shape. Keys sit at exactly two spaces;
 * block-scalar content sits deeper (a multi-line secret), and the first
 * column-zero line ends the section — the `records:` key is such a line, so its
 * nested keys can never be mistaken for references. A value whose continuation
 * line happens to be indented exactly two spaces could be misread as a key;
 * that is a naming-only false positive, never a value disclosure.
 *
 * @param text - the store document.
 * @returns reference names in document order, de-duplicated.
 */
export function parseRefNames(text, section = 'refs') {
  const names = []
  const seen = new Set()
  let inRefs = false
  for (const line of text.split(/\r?\n/)) {
    if (!inRefs) {
      if (new RegExp(`^${section}:\\s*$`).test(line)) inRefs = true
      continue
    }
    if (/^\S/.test(line)) break // column zero: the section ended
    if (/^\s*$/.test(line) || /^\s*#/.test(line)) continue
    const match = /^ {2}([A-Za-z_][A-Za-z0-9_]*):(\s|$)/.exec(line)
    if (match !== null && !seen.has(match[1])) {
      seen.add(match[1])
      names.push(match[1])
    }
  }
  return names
}

/** Top-level shapes this editor understands; anything else means "not ours". */
const TOP_LEVEL_KNOWN = /^(version:|refs:|notes:|records:|\s|#|$)/

/**
 * Refuse to edit a document this tool does not recognize.
 *
 * The provider itself fails a save rather than overwrite content it could not
 * read; a management CLI that clobbered an unexpected document would be a worse
 * failure, so this mirrors that rule.
 *
 * @param text - the current document.
 * @throws Error when the document carries an unknown top-level key.
 */
export function assertEditable(text) {
  if (text.trim().length === 0) return
  for (const line of text.split(/\r?\n/)) {
    if (!TOP_LEVEL_KNOWN.test(line)) {
      throw new Error(`存储文档里有本工具不认识的顶层内容，拒绝改写：${JSON.stringify(line.slice(0, 60))}`)
    }
  }
}

/**
 * Render a secret as a single-quoted YAML scalar.
 *
 * Single quotes are literal YAML — the only escape is a doubled quote — so any
 * password containing `#`, `:`, leading `*`/`&`, trailing spaces, or quotes
 * round-trips exactly. Multi-line values are refused rather than guessed at:
 * they belong in a key file, not an environment variable.
 *
 * @param value - the secret.
 * @returns the YAML scalar.
 * @throws Error when the value is empty or spans lines.
 */
export function quoteScalar(value) {
  if (typeof value !== 'string' || value.length === 0) throw new Error('密码不能为空（删除条目请用 del）')
  if (/[\r\n]/.test(value)) throw new Error('密码里含换行：本工具只写单行标量，多行内容请改用密钥文件')
  return `'${value.replace(/'/g, "''")}'`
}

/** Line range `[start, end)` of one top-level section, or undefined. */
function sectionRange(lines, key) {
  const head = new RegExp(`^${key}:\\s*$`)
  const start = lines.findIndex(line => head.test(line))
  if (start === -1) return undefined
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\S/.test(lines[index])) {
      end = index
      break
    }
  }
  return { start, end }
}

/** Split into lines, dropping the single trailing empty element a final \n creates. */
function toLines(text) {
  const lines = text.split(/\r?\n/)
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * Insert or replace one `refs:` entry, creating the section when absent.
 *
 * @param text - the current document.
 * @param name - the credential name.
 * @param value - the secret.
 * @returns the new document, ending in a newline.
 */
export function setRefValue(text, name, value, section = 'refs') {
  if (!isRefName(name)) throw new Error(`凭据名不合法：${JSON.stringify(name)}（须匹配 ${String(REF_PATTERN)}）`)
  const entry = `  ${name}: ${quoteScalar(value)}`
  const lines = toLines(text)
  const range = sectionRange(lines, section)

  if (range === undefined) {
    const out = [...lines]
    if (out.length > 0 && out[out.length - 1].trim() !== '') out.push('')
    out.push(`${section}:`, entry)
    return `${out.join('\n')}\n`
  }

  const head = new RegExp(`^ {2}${name}:`)
  const at = lines.findIndex((line, index) => index > range.start && index < range.end && head.test(line))
  if (at !== -1) {
    lines[at] = entry
    return `${lines.join('\n')}\n`
  }

  let insertAt = range.start + 1
  for (let index = range.start + 1; index < range.end; index += 1) {
    if (lines[index].trim() !== '') insertAt = index + 1
  }
  lines.splice(insertAt, 0, entry)
  return `${lines.join('\n')}\n`
}

/**
 * Remove one `refs:` entry, together with a comment line directly above it.
 *
 * A comment immediately above an entry is that entry's note — the provider's
 * own write path treats it that way, so deleting the key deletes the note.
 *
 * @param text - the current document.
 * @param name - the credential name.
 * @returns `{ text, removed }`; `text` is unchanged when the name was absent.
 */
export function deleteRef(text, name, section = 'refs') {
  if (!isRefName(name)) throw new Error(`凭据名不合法：${JSON.stringify(name)}（须匹配 ${String(REF_PATTERN)}）`)
  const lines = toLines(text)
  const range = sectionRange(lines, section)
  if (range === undefined) return { text, removed: false }

  const head = new RegExp(`^ {2}${name}:`)
  const at = lines.findIndex((line, index) => index > range.start && index < range.end && head.test(line))
  if (at === -1) return { text, removed: false }

  const from = at > range.start + 1 && /^ {2}#/.test(lines[at - 1]) ? at - 1 : at
  lines.splice(from, at - from + 1)
  return { text: `${lines.join('\n')}\n`, removed: true }
}
