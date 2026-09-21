/**
 * dsh-secret host half: two model-facing tools, the management service behind
 * the browser panel, and the per-session approval gate.
 *
 * Imports nothing from `@deepseek-ai/*`: every service is reached through
 * `ctx.get(...)`, and the Remote face is declared by the hand-written Typert
 * manifest in `./typert.js`, so this package needs no codegen.
 *
 *   secret_list / secret_run   the agent's side: names, and a command run with
 *                              the value injected into the child environment.
 *   secretManager (Remote)     the browser panel's side: list, set, remove.
 *                              Values travel one way only — nothing here ever
 *                              returns one.
 *
 * Approval is per SESSION: the first `secret_run` in a session asks, and the
 * session that reaches execution (which happens only after the approval channel
 * resolved that ask) is remembered, so later calls in the same session do not
 * ask again. `approval: never` opts out entirely.
 *
 * Boundary this does NOT provide: the child process is a real command, so a
 * command can still send the secret somewhere (`curl -d "$DSH_SECRET" …`).
 * Redaction protects the transcript, not the network.
 */

import { readFile } from 'node:fs/promises'

import { describeRef } from '../shared/notes.js'
import { deleteNote, notesPathOf, readNotes, renameNote, writeNote } from './notes-file.js'
import { isRefName, parseRefNames, storePath } from '../../store-edit.mjs'

/** Generic environment variable the secret is injected under. */
const SECRET_ENV = 'DSH_SECRET'

/** Replacement text for a redacted occurrence. */
const REDACTED = '«已屏蔽»'

/** Below this length a value is too generic to redact without mangling output. */
const MIN_REDACTABLE_LENGTH = 4

/** Cordis plugin name. */
export const name = 'secret'

/** The tool registry must exist before the tools can register. */
export const inject = ['tools']

/**
 * Sessions that already approved one credential use this process lifetime.
 * Written by `secret_run` once its own validation passes: reaching execution
 * proves the approval channel resolved the session's `ask` as allowed.
 */
const approvedSessions = new Set()

/**
 * Replace every occurrence of one secret with the redaction marker.
 *
 * Short values are left alone: redacting a 1–3 character secret would replace
 * unrelated output (and every such value is a weak secret to begin with).
 *
 * @param text - captured stdout or stderr.
 * @param secret - the resolved secret value.
 * @returns the text with the secret removed.
 */
export function redact(text, secret) {
  if (typeof secret !== 'string' || secret.length < MIN_REDACTABLE_LENGTH) return text
  return text.split(secret).join(REDACTED)
}

/**
 * Normalize the entry config into the facts this plugin acts on.
 *
 * @param config - this plugin's entry config.
 * @returns the store path, the approval posture, and the permitted names.
 */
export function resolveOptions(config) {
  const approval = config !== undefined && config.approval === 'never' ? 'never' : 'always'
  const allow = config !== undefined && Array.isArray(config.allow)
    ? config.allow.filter(entry => isRefName(entry))
    : []
  return { path: storePath(config), approval, allow }
}

/**
 * The session a call belongs to, or undefined when it has none.
 *
 * @param exec - the pending tool call.
 * @returns a stable session id, or undefined (which always asks).
 */
export function sessionKeyOf(exec) {
  const id = exec?.agent?.session?.id
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

/**
 * Read the reference names out of the store document.
 *
 * @param path - absolute store path.
 * @returns reference names; empty when the document does not exist yet.
 */
async function readRefNames(path) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === 'ENOENT') return []
    throw error
  }
  return parseRefNames(text)
}

/**
 * The value-free credential rows both surfaces render.
 *
 * @param ctx - host context.
 * @param options - resolved plugin options.
 * @returns one row per stored name, with the seam's own status facts.
 */
async function readRows(ctx, options) {
  const credentials = ctx.get('credentials')
  const names = await readRefNames(options.path)
  const notes = await readNotes(notesPathOf(options))
  const rows = []
  for (const name of names) {
    let info = { configured: false, writable: false }
    if (credentials !== undefined) info = await credentials.describe(name)
    rows.push({
      name,
      // The stored label wins; the derived one keeps an unlabelled store readable.
      note: notes.get(name) ?? describeRef(name),
      configured: info.configured === true,
      ...info.source === undefined ? {} : { source: info.source },
      writable: info.writable === true,
    })
  }
  return rows
}

/** The credential seam, or a clear failure when the composition has none. */
function requireCredentials(ctx) {
  const credentials = ctx.get('credentials')
  if (credentials === undefined) throw new Error('本组合没有挂载凭据服务（ctx.credentials）')
  return credentials
}

/** `secret_list` — names and value-free status, never a value. */
function listTool(ctx, options) {
  return {
    name: 'secret_list',
    description:
      'List the credential names saved in this machine\'s DSH credential store, with a value-free status '
      + '(configured / source layer / writable). Use it to learn which names you may reference with '
      + 'secret_run. It never returns a secret value, and it needs no approval.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        properties: {
          refs: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                configured: { type: 'boolean' },
                source: { type: 'string' },
                writable: { type: 'boolean' },
                note: { type: 'string' },
              },
              required: ['name', 'configured', 'writable'],
              additionalProperties: false,
            },
          },
        },
        required: ['refs'],
        additionalProperties: false,
      },
      render(_args, value) {
        const rows = Array.isArray(value?.refs) ? value.refs : []
        if (rows.length === 0) {
          return [{ type: 'text', text: '凭据存储里没有任何条目（或存储文件不存在）。' }]
        }
        const lines = rows.map((row) => {
          const state = row.configured ? '已配置' : '未配置'
          const source = row.source === undefined ? '' : ` · 来源 ${row.source}`
          const readOnly = row.writable === false ? ' · 只读（被启动环境遮蔽）' : ''
          const note = typeof row.note === 'string' && row.note !== '' ? row.note : describeRef(row.name)
          return `- ${row.name}${note === '' ? '' : ` — ${note}`} · ${state}${source}${readOnly}`
        })
        return [{ type: 'text', text: `共 ${rows.length} 条凭据（只列名字，不含值）：\n${lines.join('\n')}` }]
      },
    },
    async execute() {
      return { refs: await readRows(ctx, options) }
    },
  }
}

/** `secret_run` — run one command with the secret in its environment only. */
function runTool(ctx, options) {
  return {
    name: 'secret_run',
    description:
      'Run one shell command with a stored secret injected into its environment, and return '
      + 'stdout/stderr/exit code with every occurrence of the secret redacted. The value is never returned '
      + 'and never needs to appear in the conversation: reference it inside the command as $DSH_SECRET or as '
      + 'the credential\'s own name (e.g. "$DB_PASSWORD"). The first such call in a session asks the '
      + 'user for approval. Prefer tools that read the secret from the environment (e.g. `sshpass -e` with '
      + 'an inline SSHPASS assignment); never put it in an argv position, where `ps` would expose it.',
    parameters: {
      type: 'object',
      properties: {
        ref: {
          type: 'string',
          description: 'Credential name, matching [A-Za-z_][A-Za-z0-9_]* — e.g. DB_PASSWORD. Call secret_list for the available names.',
        },
        command: {
          type: 'string',
          description: 'Shell command to execute. Reference the secret as "$DSH_SECRET" or "$<ref>" (the name you passed).',
        },
        timeoutMs: {
          type: 'number',
          description: 'Optional timeout in milliseconds; the executor caps it.',
        },
      },
      required: ['ref', 'command'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ref: { type: 'string' },
          exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
          signal: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          timedOut: { type: 'boolean' },
          stdout: { type: 'string' },
          stderr: { type: 'string' },
          truncated: { type: 'boolean' },
        },
        required: ['ref', 'exitCode', 'signal', 'timedOut', 'stdout', 'stderr', 'truncated'],
        additionalProperties: false,
      },
      render(_args, value) {
        const status = value?.exitCode === null
          ? `killed by signal ${String(value?.signal)}`
          : `exit code ${String(value?.exitCode)}`
        const refName = String(value?.ref ?? '')
        const parts = [`[${status}] (${refName} injected as $${SECRET_ENV} and $${refName}, value redacted)`]
        const stdout = String(value?.stdout ?? '')
        const stderr = String(value?.stderr ?? '')
        if (stdout.length > 0) parts.push(`--- stdout ---\n${stdout.replace(/\n+$/, '')}`)
        if (stderr.length > 0) parts.push(`--- stderr ---\n${stderr.replace(/\n+$/, '')}`)
        if (value?.truncated === true) parts.push('(output truncated by the executor)')
        return [{ type: 'text', text: parts.join('\n') }]
      },
    },
    async execute(args, exec) {
      const ref = typeof args?.ref === 'string' ? args.ref : ''
      const command = typeof args?.command === 'string' ? args.command : ''
      if (!isRefName(ref)) {
        throw new Error(`凭据名不合法：${JSON.stringify(ref)}（须匹配 [A-Za-z_][A-Za-z0-9_]*）`)
      }
      if (command.trim().length === 0) throw new Error('command 不能为空')
      if (options.allow.length > 0 && !options.allow.includes(ref)) {
        throw new Error(`凭据 ${ref} 不在本插件允许的名字里（allow: ${options.allow.join(', ')}）`)
      }

      // Reaching execution means this session's approval ask was resolved as
      // allowed, so the rest of the session rides on it.
      const session = sessionKeyOf(exec)
      if (session !== undefined) approvedSessions.add(session)

      const resolved = await requireCredentials(ctx).resolve(ref)
      if (resolved === undefined) {
        throw new Error(`凭据 ${ref} 未配置（用 secret_list 看已存条目，或在“密码管理”面板里加一条）`)
      }

      const shell = ctx.get('shell')
      if (shell === undefined) throw new Error('本组合没有挂载 shell 服务（ctx.shell）')

      const timeoutMs = typeof args?.timeoutMs === 'number' && Number.isFinite(args.timeoutMs) && args.timeoutMs > 0
        ? args.timeoutMs
        : undefined

      // Two names for one value: the generic one every command can rely on, and
      // the credential's own name so a command reads the way it is written down.
      const env = { [SECRET_ENV]: resolved.value }
      if (ref !== SECRET_ENV) env[ref] = resolved.value

      // `run` accepts a RESOLVED spec from `resolve`, never the raw request:
      // `resolve` stamps the sandbox policy and bash-sandbox's `run` destructures
      // it, so a raw request dies with "Cannot destructure property 'mode' of
      // 'policy' as it is undefined".
      //
      // Supply the SESSION's resolved policy whenever the composition exposes
      // the service, exactly as the bash tool does: without it a session
      // confined to read-only would gain write access by routing through here.
      const policyService = ctx.get('sandboxPolicy')
      const sandboxPolicy = policyService === undefined
        ? undefined
        : policyService.resolve(exec?.agent === undefined ? {} : { session: exec.agent.session })

      const result = await shell.run(shell.resolve({
        command,
        env,
        ...timeoutMs === undefined ? {} : { timeoutMs },
        ...sandboxPolicy === undefined ? {} : { sandboxPolicy },
        ...exec?.signal === undefined ? {} : { signal: exec.signal },
      }))

      const stdout = redact(result.stdout.text, resolved.value)
      const stderr = redact(result.stderr.text, resolved.value)
      return {
        ref,
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut === true,
        stdout,
        stderr,
        truncated: result.stdout.truncated === true || result.stderr.truncated === true,
      }
    },
  }
}

/**
 * The service behind the `secretManager` Remote namespace.
 *
 * Every method answers with the whole fresh list, so the panel refreshes in the
 * same round trip that performed the write. No method returns a value.
 *
 * @param ctx - host context.
 * @param options - resolved plugin options.
 * @returns the service object the gateway exposes.
 */
export function createService(ctx, options) {
  return {
    /** Every stored name with its value-free status. */
    async list() {
      return { refs: await readRows(ctx, options) }
    },

    /**
     * Store or replace one credential.
     * @param ref - credential name.
     * @param value - the secret; never echoed back.
     */
    async set(ref, value, note) {
      if (!isRefName(ref)) {
        throw new Error(`凭据名不合法：${JSON.stringify(ref)}（须匹配 [A-Za-z_][A-Za-z0-9_]*）`)
      }
      if (typeof value !== 'string' || value.length === 0) {
        throw new Error('密码不能为空（要删除条目请用删除）')
      }
      await requireCredentials(ctx).set(ref, value)
      if (typeof note === 'string') await writeNote(notesPathOf(options), ref, note.trim())
      return { refs: await readRows(ctx, options) }
    },

    /**
     * Remove one credential.
     *
     * Named `unset`, not `remove`: the Remote namespace runtime reserves
     * `remove` on its own service object and rejects a contribution that uses
     * the name (the client mount fails with "conflicts with its namespace
     * service"). This also matches the credential seam's own `unset`.
     * @param ref - credential name.
     */
    async unset(ref) {
      if (!isRefName(ref)) {
        throw new Error(`凭据名不合法：${JSON.stringify(ref)}（须匹配 [A-Za-z_][A-Za-z0-9_]*）`)
      }
      await requireCredentials(ctx).unset(ref)
      await deleteNote(notesPathOf(options), ref)
      return { refs: await readRows(ctx, options) }
    },

    /**
     * Store or clear one credential's Chinese label.
     * @param ref - credential name; it must already exist.
     * @param note - the label; `''` restores the derived fallback.
     */
    async setNote(ref, note) {
      if (!isRefName(ref)) {
        throw new Error(`凭据名不合法：${JSON.stringify(ref)}（须匹配 [A-Za-z_][A-Za-z0-9_]*）`)
      }
      const names = await readRefNames(options.path)
      if (!names.includes(ref)) throw new Error(`凭据 ${ref} 不存在，先新增再改说明`)
      await writeNote(notesPathOf(options), ref, String(note ?? '').trim())
      return { refs: await readRows(ctx, options) }
    },

    /**
     * Rename one credential, value and label together.
     *
     * The value is read and rewritten host-side, so renaming never exposes it to
     * the browser — this is the one operation the panel cannot do with set/unset.
     * @param from - current credential name.
     * @param to - new credential name.
     */
    async rename(from, to) {
      if (!isRefName(from) || !isRefName(to)) {
        throw new Error(`凭据名不合法（须匹配 [A-Za-z_][A-Za-z0-9_]*）：${JSON.stringify({ from, to })}`)
      }
      if (from === to) return { refs: await readRows(ctx, options) }
      const names = await readRefNames(options.path)
      if (!names.includes(from)) throw new Error(`凭据 ${from} 不存在`)
      if (names.includes(to)) throw new Error(`目标名字 ${to} 已存在，请换一个`)
      const credentials = requireCredentials(ctx)
      const resolved = await credentials.resolve(from)
      if (resolved === undefined) throw new Error(`凭据 ${from} 没有可读取的值（可能由启动环境提供，无法改名）`)
      await credentials.set(to, resolved.value)
      await credentials.unset(from)
      await renameNote(notesPathOf(options), from, to)
      return { refs: await readRows(ctx, options) }
    },
  }
}

/**
 * Mount the tools, the Remote service, and the per-session approval gate.
 *
 * @param ctx - the cordis context (declares `inject = ['tools']`).
 * @param config - entry config: `{ path?, approval?, allow? }`. See README.
 */
export function apply(ctx, config) {
  // A THROWING apply is how a plugin takes the whole host down: the loader
  // reports the entry as "did not activate" and the Web GUI shows a
  // failed-plugins screen instead of the app. This plugin is a personal
  // convenience and must never be able to do that, so activation failure
  // degrades it to "not mounted" and the reason goes to the harness log.
  try {
    mount(ctx, config)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    try {
      ctx.logger?.error?.(`dsh-secret: activation failed, plugin not mounted: ${message}`)
    } catch {
      // Logging must not resurrect the failure it is reporting.
    }
  }
}

/**
 * Register everything this plugin contributes.
 *
 * @param ctx - the cordis context (declares `inject = ['tools']`).
 * @param config - entry config: `{ path?, approval?, allow? }`. See README.
 * @throws Whatever a registration call throws; {@link apply} contains it.
 */
function mount(ctx, config) {
  const options = resolveOptions(config)

  ctx.effect(() => ctx.tools.register(listTool(ctx, options)), 'secret: secret_list')
  ctx.effect(() => ctx.tools.register(runTool(ctx, options)), 'secret: secret_run')

  const service = createService(ctx, options)
  Object.defineProperty(service, 'typertRemote', {
    configurable: false,
    enumerable: false,
    writable: false,
    value: { service, serviceKey: 'secretManager', namespace: 'secretManager' },
  })
  ctx.provide('secretManager', service)

  if (options.approval === 'never') return

  // The approval channel is asked once per session: the first secret_run in a
  // session produces the `ask`, and only a call that actually executes — which
  // requires that ask to have resolved as allowed — records the session.
  // A composition with no approval channel denies instead of running (the
  // tools pipeline is fail-closed on `ask`).
  ctx.effect(() => ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec === undefined || exec.name !== 'secret_run') return next()
    const session = sessionKeyOf(exec)
    if (session !== undefined && approvedSessions.has(session)) return next()
    const args = exec.arguments
    const ref = args !== null && typeof args === 'object' && typeof args.ref === 'string' ? args.ref : '(未指定)'
    return {
      kind: 'ask',
      reason: `dsh-secret：本会话首次使用凭据 ${ref} 执行命令（值注入子进程，输出已脱敏）。确认后本会话不再询问。`,
    }
  }), 'secret: approval gate')

  ctx.effect(() => () => { approvedSessions.clear() }, 'secret: approval ledger')
}
