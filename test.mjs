/**
 * Self-check for dsh-secret. Runs without the harness: the cordis context, the
 * credential seam, and the shell executor are all faked, so this proves the
 * plugin's own logic (YAML key scan, redaction, tool shapes, env injection,
 * error paths) — not the live integration, which needs an installed profile.
 *
 *   node test.mjs
 */

import assert from 'node:assert/strict'
import { apply, redact, resolveOptions } from './src/host/index.js'
import {
  assertEditable, deleteRef, isRefName, parseRefNames, quoteScalar, setRefValue, storePath,
} from './store-edit.mjs'

const SECRET = 'hunter2-hunter2'

/* ---------------------------------------------------------------- fixtures */

const STORE = `version: 1

refs:
  DEEPSEEK_API_KEY: sk-abc
  # a note above an entry
  MULTILINE_SECRET: |
    first line
    second: line
  VPS_ROOT_PASSWORD: "${SECRET}"
  SHORT: ab

records:
  llm-pi-ai/openai-codex:
    kind: grant
    payload:
      type: oauth
`

function makeCtx({ describe, resolve, run, sandboxPolicy, set: storeSet, unset: storeUnset } = {}) {
  const registered = []
  const listeners = []
  const provided = {}
  return {
    registered,
    listeners,
    provided,
    effect: (fn) => fn(),
    provide: (key, value) => { provided[key] = value },
    on: (event, handler) => {
      listeners.push({ event, handler })
      return () => {}
    },
    get: (name) => {
      if (name === 'credentials') {
        return {
          describe: async (ref) => (describe ?? (() => ({ configured: true, source: 'file', writable: true })))(ref),
          resolve: async (ref) => (resolve ?? (() => ({ value: SECRET, source: 'file' })))(ref),
          set: async (ref, value) => { if (storeSet !== undefined) await storeSet(ref, value) },
          unset: async (ref) => { if (storeUnset !== undefined) await storeUnset(ref) },
        }
      }
      if (name === 'shell') {
        return {
          // Faithful contract: `run` accepts only a spec produced by `resolve`,
          // and `resolve` is what stamps `sandboxPolicy`. Handing `run` the raw
          // request reproduces the real crash verbatim.
          resolve: (request) => ({
            ...request,
            workdir: '/tmp',
            timeoutMs: request.timeoutMs ?? 1_000,
            stdoutMaxBytes: 1_000_000,
            sandboxPolicy: request.sandboxPolicy ?? { mode: 'workspace-write' },
          }),
          run: async (spec) => {
            if (spec?.sandboxPolicy === undefined) {
              throw new Error("Cannot destructure property 'mode' of 'policy' as it is undefined.")
            }
            return (run ?? (() => ({
              exitCode: 0, signal: null, timedOut: false, timeoutMs: 1_000,
              stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false },
            })))(spec)
          },
        }
      }
      if (name === 'sandboxPolicy') return sandboxPolicy
      return undefined
    },
    tools: {
      register: (definition) => {
        registered.push(definition)
        return () => {}
      },
    },
  }
}

const results = []
function check(name, fn) {
  try {
    fn()
    results.push(`  ok   ${name}`)
  } catch (error) {
    results.push(`  FAIL ${name}\n       ${error.message}`)
    process.exitCode = 1
  }
}
async function checkAsync(name, fn) {
  try {
    await fn()
    results.push(`  ok   ${name}`)
  } catch (error) {
    results.push(`  FAIL ${name}\n       ${error.message}`)
    process.exitCode = 1
  }
}

/* -------------------------------------------------------- store path scan */

check('storePath: DSH_HOME default', () => {
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = '/tmp/dsh-home'
  assert.equal(storePath(undefined), '/tmp/dsh-home/.credentials.yaml')
  assert.equal(storePath({}), '/tmp/dsh-home/.credentials.yaml')
  assert.equal(storePath({ path: '/custom/store.yaml' }), '/custom/store.yaml')
  if (previous === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previous
})

check('parseRefNames: only refs keys, records excluded', () => {
  assert.deepEqual(parseRefNames(STORE), [
    'DEEPSEEK_API_KEY', 'MULTILINE_SECRET', 'VPS_ROOT_PASSWORD', 'SHORT',
  ])
})

check('parseRefNames: block-scalar content is not a key', () => {
  assert.equal(parseRefNames(STORE).includes('second'), false)
  assert.equal(parseRefNames(STORE).includes('first'), false)
})

check('parseRefNames: no refs section → empty', () => {
  assert.deepEqual(parseRefNames('version: 1\n\nrecords:\n  a/b:\n    kind: grant\n'), [])
})

check('parseRefNames: duplicate key collapses', () => {
  assert.deepEqual(parseRefNames('refs:\n  A: 1\n  A: 2\n'), ['A'])
})

/* --------------------------------------------------------------- redaction */

check('redact: replaces every occurrence', () => {
  assert.equal(redact(`x ${SECRET} y ${SECRET}`, SECRET), 'x «已屏蔽» y «已屏蔽»')
})

check('redact: short values are left alone', () => {
  assert.equal(redact('ab is everywhere', 'ab'), 'ab is everywhere')
})

/* ------------------------------------------------------------ config knobs */

check('resolveOptions: approval defaults ON, allow defaults empty', () => {
  const options = resolveOptions(undefined)
  assert.equal(options.approval, 'always')
  assert.deepEqual(options.allow, [])
  assert.equal(typeof options.path, 'string')
})

check('resolveOptions: only the exact "never" opts out of approval', () => {
  assert.equal(resolveOptions({ approval: 'never' }).approval, 'never')
  assert.equal(resolveOptions({ approval: 'sometimes' }).approval, 'always')
  assert.equal(resolveOptions({ approval: false }).approval, 'always')
})

check('resolveOptions: allow drops malformed entries instead of keeping them', () => {
  assert.deepEqual(resolveOptions({ allow: ['OK_NAME', 'bad-name', 7, 'ALSO_OK'] }).allow, ['OK_NAME', 'ALSO_OK'])
  assert.deepEqual(resolveOptions({ allow: 'OK_NAME' }).allow, [])
})

/* ------------------------------------------------------------- registration */

check('apply: registers both tools with the expected names', () => {
  const ctx = makeCtx()
  apply(ctx, undefined)
  assert.deepEqual(ctx.registered.map(def => def.name).sort(), ['secret_list', 'secret_run'])
})

check('apply: every registered tool exposes the plain ToolDefinition shape', () => {
  const ctx = makeCtx()
  apply(ctx, undefined)
  for (const def of ctx.registered) {
    assert.equal(typeof def.description, 'string')
    assert.equal(def.parameters.type, 'object')
    assert.equal(typeof def.execute, 'function')
    assert.equal(typeof def.output.render, 'function')
    assert.equal(typeof def.output.schema, 'object')
  }
})

/* -------------------------------------------------------------- secret_list */

await checkAsync('secret_list: reports names and value-free status', async () => {
  const ctx = makeCtx({
    describe: (ref) => ref === 'SHORT'
      ? { configured: false, writable: false }
      : { configured: true, source: 'file', writable: true },
  })
  apply(ctx, { path: '/tmp/does-not-matter.yaml' })
  const tool = ctx.registered.find(def => def.name === 'secret_list')
  // Point the scan at the fixture by stubbing the read through a temp file.
  const { writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const path = join(tmpdir(), `dsh-secret-test-${process.pid}.yaml`)
  await writeFile(path, STORE)
  const fresh = makeCtx({
    describe: (ref) => ref === 'SHORT'
      ? { configured: false, writable: false }
      : { configured: true, source: 'file', writable: true },
  })
  apply(fresh, { path })
  const value = await fresh.registered.find(def => def.name === 'secret_list').execute({}, {})
  await rm(path)

  assert.deepEqual(value.refs.map(row => row.name), [
    'DEEPSEEK_API_KEY', 'MULTILINE_SECRET', 'VPS_ROOT_PASSWORD', 'SHORT',
  ])
  assert.deepEqual(value.refs[0], { name: 'DEEPSEEK_API_KEY', configured: true, source: 'file', writable: true, note: 'DeepSeek 平台 API 密钥（模型调用）' })
  assert.deepEqual(value.refs[3], { name: 'SHORT', configured: false, writable: false, note: '' })
  assert.equal(JSON.stringify(value).includes(SECRET), false)

  // Returned rows must match the declared output schema exactly.
  const allowed = Object.keys(tool.output.schema.properties.refs.items.properties)
  for (const row of value.refs) {
    assert.deepEqual(Object.keys(row).every(key => allowed.includes(key)), true)
  }
  assert.deepEqual(tool.output.render({}, value)[0].type, 'text')
})

await checkAsync('secret_list: missing store file → empty list, no throw', async () => {
  const ctx = makeCtx()
  apply(ctx, { path: '/tmp/dsh-secret-definitely-absent.yaml' })
  const value = await ctx.registered.find(def => def.name === 'secret_list').execute({}, {})
  assert.deepEqual(value, { refs: [] })
})

/* --------------------------------------------------------------- secret_run */

await checkAsync('secret_run: injects DSH_SECRET and redacts it from output', async () => {
  let seen = undefined
  const ctx = makeCtx({
    run: (spec) => {
      seen = spec
      return {
        exitCode: 0, signal: null, timedOut: false, timeoutMs: 1_000,
        stdout: { text: `password is ${SECRET}\n`, truncated: false },
        stderr: { text: `warn ${SECRET}`, truncated: false },
      }
    },
  })
  apply(ctx, undefined)
  const tool = ctx.registered.find(def => def.name === 'secret_run')
  const value = await tool.execute({ ref: 'VPS_ROOT_PASSWORD', command: 'echo "$DSH_SECRET"' }, { signal: undefined })

  assert.deepEqual(seen.env, { DSH_SECRET: SECRET, VPS_ROOT_PASSWORD: SECRET })
  assert.equal(seen.command, 'echo "$DSH_SECRET"')
  assert.deepEqual(Object.keys(value).sort(), Object.keys(tool.output.schema.properties).sort())
  assert.equal(value.exitCode, 0)
  assert.equal(value.stdout, 'password is «已屏蔽»\n')
  assert.equal(value.stderr, 'warn «已屏蔽»')
  assert.equal(JSON.stringify(value).includes(SECRET), false)
  assert.equal(tool.output.render({}, value)[0].text.includes(SECRET), false)
})

await checkAsync('secret_run: hands the executor a resolved spec carrying the session policy', async () => {
  let seen = undefined
  const ctx = makeCtx({
    run: (spec) => {
      seen = spec
      return {
        exitCode: 0, signal: null, timedOut: false, timeoutMs: 1_000,
        stdout: { text: 'ok', truncated: false }, stderr: { text: '', truncated: false },
      }
    },
    sandboxPolicy: { resolve: () => ({ mode: 'read-only' }) },
  })
  apply(ctx, undefined)
  const tool = ctx.registered.find(def => def.name === 'secret_run')
  const value = await tool.execute({ ref: 'VPS_ROOT_PASSWORD', command: 'echo ok' }, { signal: undefined })

  assert.equal(value.stdout, 'ok')
  // The executor must receive a resolved spec, and a session confined to
  // read-only must stay confined through this tool.
  assert.deepEqual(seen.sandboxPolicy, { mode: 'read-only' })
})

await checkAsync('secret_run: unconfigured ref refuses before running anything', async () => {
  let ran = false
  const ctx = makeCtx({ resolve: () => undefined, run: () => { ran = true } })
  apply(ctx, undefined)
  const tool = ctx.registered.find(def => def.name === 'secret_run')
  await assert.rejects(
    () => tool.execute({ ref: 'NOPE_MISSING', command: 'true' }, {}),
    /未配置/,
  )
  assert.equal(ran, false)
})

await checkAsync('secret_run: malformed name refuses before resolving', async () => {
  const ctx = makeCtx()
  apply(ctx, undefined)
  const tool = ctx.registered.find(def => def.name === 'secret_run')
  await assert.rejects(() => tool.execute({ ref: 'bad-name', command: 'true' }, {}), /不合法/)
  await assert.rejects(() => tool.execute({ ref: 'OK_NAME', command: '   ' }, {}), /不能为空/)
})

await checkAsync('secret_run: missing shell service reports clearly', async () => {
  const ctx = makeCtx()
  ctx.get = (name) => name === 'credentials'
    ? { resolve: async () => ({ value: SECRET, source: 'file' }), describe: async () => ({ configured: true, writable: true }) }
    : undefined
  apply(ctx, undefined)
  const tool = ctx.registered.find(def => def.name === 'secret_run')
  await assert.rejects(() => tool.execute({ ref: 'OK_NAME', command: 'true' }, {}), /shell/)
})

/* ------------------------------------------------------------------- guard */

check('apply: the approval gate is mounted by default and dropped by approval=never', () => {
  const byDefault = makeCtx()
  apply(byDefault, undefined)
  assert.deepEqual(byDefault.listeners.map(entry => entry.event), ['tools/pre-execute'])

  const optedOut = makeCtx()
  apply(optedOut, { approval: 'never' })
  assert.deepEqual(optedOut.listeners, [])
})

await checkAsync('approval gate: asks for secret_run, defers every other tool', async () => {
  const ctx = makeCtx()
  apply(ctx, { approval: 'always' })
  const gate = ctx.listeners[0].handler
  let delegated = 0
  const next = async () => {
    delegated += 1
    return { kind: 'allow' }
  }

  assert.deepEqual(await gate({ name: 'bash', arguments: {} }, next), { kind: 'allow' })
  assert.equal(delegated, 1)

  const decision = await gate({ name: 'secret_run', arguments: { ref: 'VPS_ROOT_PASSWORD' } }, next)
  assert.equal(decision.kind, 'ask')
  assert.equal(decision.reason.includes('VPS_ROOT_PASSWORD'), true)
  assert.equal(delegated, 1) // an ask is not an allow: nothing ran downstream

  const nameless = await gate({ name: 'secret_run', arguments: {} }, next)
  assert.equal(nameless.kind, 'ask')
  assert.equal(nameless.reason.includes('未指定'), true)

  // Reading names never needs consent: no value can cross it.
  assert.deepEqual(await gate({ name: 'secret_list', arguments: {} }, next), { kind: 'allow' })
})

await checkAsync('allowlist: a name outside allow never reaches the credential seam', async () => {
  let resolved = false
  const ctx = makeCtx({
    resolve: () => {
      resolved = true
      return { value: SECRET, source: 'file' }
    },
  })
  apply(ctx, { allow: ['ONLY_THIS_ONE'] })
  const tool = ctx.registered.find(def => def.name === 'secret_run')
  await assert.rejects(
    () => tool.execute({ ref: 'VPS_ROOT_PASSWORD', command: 'true' }, {}),
    /不在本插件允许的名字里/,
  )
  assert.equal(resolved, false)
  const permitted = await tool.execute({ ref: 'ONLY_THIS_ONE', command: 'true' }, {})
  assert.equal(permitted.ref, 'ONLY_THIS_ONE')
})

/* ------------------------------------------------------- store document edits */

check('quoteScalar: special characters survive in single quotes', () => {
  assert.equal(quoteScalar("p#ss:word *x* 'q' trailing "), "'p#ss:word *x* ''q'' trailing '")
  assert.throws(() => quoteScalar(''), /不能为空/)
  assert.throws(() => quoteScalar('a\nb'), /换行/)
})

check('setRefValue: replaces in place, keeping comments and order', () => {
  const before = 'version: 1\n\nrefs:\n  A: old\n  # note for B\n  B: keep\n'
  assert.equal(setRefValue(before, 'A', 'new'), "version: 1\n\nrefs:\n  A: 'new'\n  # note for B\n  B: keep\n")
})

check('setRefValue: a new key lands inside refs, before records', () => {
  const before = 'version: 1\n\nrefs:\n  A: 1\n\nrecords:\n  x/y:\n    kind: grant\n'
  const after = setRefValue(before, 'NEW_ONE', 'v')
  assert.deepEqual(parseRefNames(after), ['A', 'NEW_ONE'])
  assert.equal(after.indexOf('NEW_ONE') < after.indexOf('records:'), true)
  assert.equal(parseRefNames(after).includes('x/y'), false)
})

check('setRefValue: creates the refs section in an empty document', () => {
  const after = setRefValue('', 'FIRST', 'v')
  assert.equal(after, "refs:\n  FIRST: 'v'\n")
  assert.deepEqual(parseRefNames(after), ['FIRST'])
})

check('deleteRef: removes the key together with its note', () => {
  const before = 'version: 1\n\nrefs:\n  A: 1\n  # note for B\n  B: 2\n'
  const { text, removed } = deleteRef(before, 'B')
  assert.equal(removed, true)
  assert.deepEqual(parseRefNames(text), ['A'])
  assert.equal(text.includes('# note for B'), false)
})

check('deleteRef: an absent name changes nothing', () => {
  const before = 'refs:\n  A: 1\n'
  assert.deepEqual(deleteRef(before, 'NOPE'), { text: before, removed: false })
})

check('assertEditable: refuses a document with a foreign top-level key', () => {
  assert.doesNotThrow(() => assertEditable('version: 1\n\nrefs:\n  A: 1\nrecords:\n  x/y:\n    kind: grant\n'))
  assert.doesNotThrow(() => assertEditable(''))
  assert.throws(() => assertEditable('version: 1\nanything: else\n'), /不认识的顶层内容/)
})

check('isRefName: the grammar the CLI and the seam share', () => {
  assert.equal(isRefName('OK_NAME'), true)
  assert.equal(isRefName('bad-name'), false)
  assert.equal(isRefName('1LEADING'), false)
  assert.equal(isRefName(undefined), false)
})

/* ------------------------------------------------------------------ CLI e2e */

await checkAsync('cli: set --stdin writes 0600, list reads, del removes', async () => {
  const { execFileSync } = await import('node:child_process')
  const { mkdtemp, readFile: readFileAsync, rm, stat: statAsync } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  const cli = new URL('./cli.mjs', import.meta.url).pathname
  const dir = await mkdtemp(join(tmpdir(), 'dsh-secret-cli-'))
  const store = join(dir, 'creds.yaml')
  const env = { ...process.env, DSH_SECRET_STORE: store }
  const run = (...args) => execFileSync(process.execPath, [cli, ...args], { env, encoding: 'utf8' })

  try {
    const secret = "p#ss word 'quoted'"
    const added = execFileSync(process.execPath, [cli, 'set', 'VPS_ROOT_PASSWORD', '--stdin'], {
      env, input: `${secret}\n`, encoding: 'utf8',
    })
    assert.equal(added.includes('已新增 VPS_ROOT_PASSWORD'), true)
    assert.equal(added.includes(secret), false, 'the CLI must never echo the value back')

    const written = await readFileAsync(store, 'utf8')
    assert.equal(written, "refs:\n  VPS_ROOT_PASSWORD: 'p#ss word ''quoted'''\n")
    assert.deepEqual(parseRefNames(written), ['VPS_ROOT_PASSWORD'])
    assert.equal((await statAsync(store)).mode & 0o777, 0o600)

    assert.equal(run('list').includes('VPS_ROOT_PASSWORD'), true)

    // Re-setting the same name replaces rather than duplicates.
    execFileSync(process.execPath, [cli, 'set', 'VPS_ROOT_PASSWORD', '--stdin'], {
      env, input: 'second\n', encoding: 'utf8',
    })
    const replaced = await readFileAsync(store, 'utf8')
    assert.deepEqual(parseRefNames(replaced), ['VPS_ROOT_PASSWORD'])
    assert.equal(replaced.includes("'second'"), true)
    assert.equal(replaced.includes('quoted'), false)

    execFileSync(process.execPath, [cli, 'set', 'SECOND_ONE', '--stdin'], { env, input: 'x\n', encoding: 'utf8' })
    assert.deepEqual(parseRefNames(await readFileAsync(store, 'utf8')), ['VPS_ROOT_PASSWORD', 'SECOND_ONE'])

    assert.equal(run('del', 'VPS_ROOT_PASSWORD').includes('已删除'), true)
    assert.deepEqual(parseRefNames(await readFileAsync(store, 'utf8')), ['SECOND_ONE'])

    // Deleting an absent name is a no-op, not an error.
    assert.equal(run('del', 'NOT_THERE').includes('没有 NOT_THERE'), true)

    // A malformed name is refused before anything is written.
    assert.throws(() => run('set', 'bad-name', '--stdin'), /Command failed|凭据名不合法/)
    assert.deepEqual(parseRefNames(await readFileAsync(store, 'utf8')), ['SECOND_ONE'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------- management service */

/** A context whose credential seam records writes instead of persisting them. */
function makeServiceCtx(writes) {
  return {
    get: (name) => name === 'credentials'
      ? {
        describe: async () => ({ configured: true, source: 'file', writable: true }),
        set: async (ref, value) => { writes.push(['set', ref, value]) },
        unset: async (ref) => { writes.push(['unset', ref]) },
      }
      : undefined,
  }
}

await checkAsync('service: list reads the store and reports value-free status', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'dsh-secret-svc-'))
  const path = join(dir, 'creds.yaml')
  await writeFile(path, 'version: 1\n\nrefs:\n  A: 1\n  B: 2\n')
  try {
    const ctx = makeCtx()
    apply(ctx, { path })
    const service = ctx.provided.secretManager
    assert.equal(typeof service, 'object')
    assert.deepEqual(service.typertRemote, { service, serviceKey: 'secretManager', namespace: 'secretManager' })
    const listed = await service.list()
    assert.deepEqual(listed.refs.map(row => row.name), ['A', 'B'])
    assert.deepEqual(listed.refs[0], { name: 'A', configured: true, source: 'file', writable: true, note: '' })
    assert.equal(JSON.stringify(listed).includes(SECRET), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

await checkAsync('service: set validates before writing and answers with the list', async () => {
  const writes = []
  const ctx = { get: makeServiceCtx(writes).get, ...makeCtx() }
  ctx.get = makeServiceCtx(writes).get
  const { createService } = await import('./src/host/index.js')
  const service = createService(ctx, { path: '/tmp/dsh-secret-does-not-exist.yaml', allow: [], approval: 'always' })

  await assert.rejects(() => service.set('bad-name', 'v'), /不合法/)
  await assert.rejects(() => service.set('OK_NAME', ''), /不能为空/)
  assert.deepEqual(writes, [])

  const after = await service.set('OK_NAME', 'v')
  assert.deepEqual(writes, [['set', 'OK_NAME', 'v']])
  assert.deepEqual(after, { refs: [] })

  await service.unset('OK_NAME')
  assert.deepEqual(writes, [['set', 'OK_NAME', 'v'], ['unset', 'OK_NAME']])
})

/* --------------------------------------------------- per-session approval */

await checkAsync('approval: asks once per session, then rides on that approval', async () => {
  const ctx = makeCtx()
  apply(ctx, undefined)
  const gate = ctx.listeners[0].handler
  const tool = ctx.registered.find(definition => definition.name === 'secret_run')
  const exec = { name: 'secret_run', arguments: { ref: 'VPS_ROOT_PASSWORD' }, agent: { session: { id: 'session-1' } } }
  let delegated = 0
  const next = async () => { delegated += 1; return { kind: 'allow' } }

  assert.equal((await gate(exec, next)).kind, 'ask', 'first use in a session asks')
  assert.equal(delegated, 0)

  // Execution only happens after the approval channel allowed the ask.
  await tool.execute({ ref: 'VPS_ROOT_PASSWORD', command: 'true' }, exec)

  assert.deepEqual(await gate(exec, next), { kind: 'allow' })
  assert.equal(delegated, 1, 'the approved session does not ask again')

  const other = { ...exec, agent: { session: { id: 'session-2' } } }
  assert.equal((await gate(other, next)).kind, 'ask', 'another session asks for itself')

  const anonymous = { name: 'secret_run', arguments: { ref: 'X' } }
  assert.equal((await gate(anonymous, next)).kind, 'ask', 'a call with no session always asks')

  assert.deepEqual(await gate({ name: 'secret_list', arguments: {} }, next), { kind: 'allow' })
})

/* ------------------------------------------- real harness schema constraint */

await checkAsync('tool schemas pass the harness JSON-Schema validator', async () => {
  // The one check the stubs above cannot do: `ctx.tools.register` runs the real
  // `assertSupportedJsonSchema` over every definition, and that validator accepts
  // a narrower subset than JSON Schema does — no `type` arrays, `oneOf` instead.
  // A hand-written definition must be measured against it, not against our own
  // idea of a valid schema. (Shipping `type: ['integer','null']` here is what
  // broke a real dsh boot: the entry threw and the CLI pruned the bundle.)
  const { homedir } = await import('node:os')
  const { join } = await import('node:path')
  // The validator only exists in a dsh checkout, so this one check is opt-in:
  // point DSH_TOOLS_LIB at `packages/core/tools/lib/index.js`, or keep a
  // checkout at the conventional ~/deepseek-harness/deepseek-harness.
  const candidates = [
    process.env.DSH_TOOLS_LIB,
    join(homedir(), 'deepseek-harness', 'deepseek-harness', 'packages', 'core', 'tools', 'lib', 'index.js'),
  ].filter(candidate => typeof candidate === 'string' && candidate.length > 0)
  let assertSupportedJsonSchema
  for (const candidate of candidates) {
    try {
      ({ assertSupportedJsonSchema } = await import(candidate))
      break
    } catch {
      // Try the next candidate.
    }
  }
  if (assertSupportedJsonSchema === undefined) {
    results.push('  skip tool schemas pass the harness JSON-Schema validator（设 DSH_TOOLS_LIB 可启用）')
    return
  }
  const ctx = makeCtx()
  apply(ctx, undefined)
  assert.equal(ctx.registered.length, 2)
  for (const definition of ctx.registered) {
    assert.doesNotThrow(
      () => assertSupportedJsonSchema(definition.parameters),
      `${definition.name} 的 parameters 不在 harness 支持的子集内`,
    )
    assert.doesNotThrow(
      () => assertSupportedJsonSchema(definition.output.schema),
      `${definition.name} 的 output.schema 不在 harness 支持的子集内`,
    )
  }
})

/* ------------------------------------------------------- fail-safe booting */

await checkAsync('apply: a registration failure degrades the plugin, never the boot', async () => {
  const logged = []
  const ctx = makeCtx()
  ctx.logger = { error: message => { logged.push(String(message)) } }
  ctx.tools.register = () => { throw new Error('register exploded') }
  assert.doesNotThrow(() => apply(ctx, undefined), 'apply must contain every registration failure')
  assert.equal(logged.length, 1)
  assert.match(logged[0], /activation failed/)
  assert.match(logged[0], /register exploded/)
})

/* ------------------------------------------- remote namespace name rules */

await checkAsync('remote method names avoid the namespace service\'s reserved members', async () => {
  // `RemoteNamespaceService.assertMethodAvailable` rejects a contributed method
  // whose name lives on its own service object — `remove` is one such name, and
  // a contribution using it fails the CLIENT mount ("conflicts with its
  // namespace service"). Read the reserved set out of the real source so this
  // cannot regress silently.
  const { homedir } = await import('node:os')
  const { join } = await import('node:path')
  // Opt-in like the schema check: DSH_GATEWAY_CLIENT_SRC, or a checkout at the
  // conventional location.
  const source = process.env.DSH_GATEWAY_CLIENT_SRC
    ?? join(homedir(), 'deepseek-harness', 'deepseek-harness', 'packages', 'api', 'gateway', 'src', 'client', 'index.ts')
  const { readFile } = await import('node:fs/promises')
  let text
  try {
    text = await readFile(source, 'utf8')
  } catch {
    results.push('  skip remote method names avoid the namespace service\'s reserved members（未找到 gateway 源码）')
    return
  }
  const fields = /REMOTE_NAMESPACE_FIELDS = new Set\(\[([^\]]*)\]\)/.exec(text)
  const reserved = new Set((fields?.[1] ?? '').split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean))
  const after = text.slice(text.indexOf('class RemoteNamespaceService'))
  const stop = /\n(?:const|function|class|interface|type) /.exec(after)
  const body = stop === null ? after : after.slice(0, stop.index)
  for (const member of body.matchAll(/^  (?:static |get |private |readonly |async )*([a-zA-Z$][\w$]*)\s*[(<]/gm)) {
    reserved.add(member[1])
  }
  assert.equal(reserved.has('remove'), true, '提取失败：remove 本应在保留名单里')
  const { INVOCATIONS } = await import('./src/shared/wire.js')
  for (const invocation of INVOCATIONS) {
    assert.equal(reserved.has(invocation.method), false,
      `方法名 ${invocation.method} 与 Remote 命名空间服务保留成员冲突`)
  }
})

/* ------------------------------------------------- remote name agreement */

await checkAsync('the three name lists agree: wire invocations, typert manifest, service methods', async () => {
  // A rename must land in ALL three places or the contribution half-mounts:
  // the client calls `unset` while a host that still declares `remove` answers
  // HTTP 404 for /api/secretManager/unset. This is exactly that check.
  const { INVOCATIONS } = await import('./src/shared/wire.js')
  const { default: _unused, ...typertModule } = await import('./src/host/typert.js')
  const manifest = typertModule.TYPERT ?? _unused
  const json = JSON.stringify(manifest)
  const declared = new Set([...json.matchAll(/"name":"([a-zA-Z$][\w$]*)","kind":"method"/g)].map(m => m[1]))
  assert.equal(declared.size, 5, `typert 清单里应有 5 个方法，实际 ${declared.size}`)

  const ctx = makeCtx()
  apply(ctx, undefined)
  const service = ctx.provided.secretManager
  const wired = new Set(INVOCATIONS.map(invocation => invocation.method))
  const served = new Set(Object.keys(service).filter(key => typeof service[key] === 'function'))

  assert.deepEqual([...declared].sort(), [...wired].sort(), 'typert 清单与 wire 声明不一致')
  assert.deepEqual([...served].sort(), [...declared].sort(), '宿主服务方法名与 typert 清单不一致')
})

/* ------------------------------------------------------------- descriptions */

await checkAsync('describeRef: known names and suffix rules, no invention', async () => {
  const { describeRef } = await import('./src/shared/notes.js')
  assert.equal(describeRef('JEV_API_KEY'), 'JEV 的 API 密钥')
  assert.equal(describeRef('VPS_ROOT_PASSWORD'), 'VPS root 登录密码')
  assert.equal(describeRef('MOONSHOT_API_KEY'), 'Moonshot（月之暗面）API 密钥')
  assert.equal(describeRef('FOO_API_KEY'), 'FOO 的 API 密钥')
  assert.equal(describeRef('BAR_BOT_TOKEN'), 'BAR 的机器人令牌')
  assert.equal(describeRef('OPENAI_API_KEY'), 'OpenAI 的 API 密钥')
  assert.equal(describeRef('WEIRD'), '', '认不出来的名字不编造说明')
  assert.equal(describeRef(''), '')
})

await checkAsync('secret_list: carries the Chinese description into its text', async () => {
  const { mkdtemp, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'dsh-secret-note-'))
  const path = join(dir, 'creds.yaml')
  await writeFile(path, 'version: 1\n\nrefs:\n  VPS_ROOT_PASSWORD: x\n  JEV_API_KEY: y\n  WEIRD: z\n')
  const ctx = makeCtx()
  apply(ctx, { path })
  const tool = ctx.registered.find(def => def.name === 'secret_list')
  const value = await tool.execute({}, {})
  const text = tool.output.render({}, value)[0].text

  assert.match(text, /VPS_ROOT_PASSWORD — VPS root 登录密码/)
  assert.match(text, /JEV_API_KEY — JEV 的 API 密钥/)
  assert.match(text, /WEIRD · /, '没有说明的名字不留破折号')
  assert.equal(text.includes('x'), false, '列表文本永不包含值')
})

await checkAsync('notes: stored labels, rename moves value+label, fallbacks, refusals', async () => {
  const { mkdtemp, readFile, rm, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { setRefValue, deleteRef } = await import('./store-edit.mjs')
  const dir = await mkdtemp(join(tmpdir(), 'dsh-secret-notes-'))
  const path = join(dir, 'creds.yaml')
  const notesPath = join(dir, '.credentials-notes.yaml')
  await writeFile(path, "version: 1\n\nrefs:\n  JEV_API_KEY: 'x'\n  VPS_ROOT_PASSWORD: 'y'\n")
  // A seam that really mutates the file, so the list reflects every write.
  const ctx = makeCtx({
    resolve: async () => ({ value: SECRET, source: 'file' }),
    set: async (ref, value) => {
      const text = await readFile(path, 'utf8')
      await writeFile(path, setRefValue(text, ref, value))
    },
    unset: async (ref) => {
      const text = await readFile(path, 'utf8')
      await writeFile(path, deleteRef(text, ref).text)
    },
  })
  apply(ctx, { path, notesPath })
  const service = ctx.provided.secretManager

  let rows = (await service.list()).refs
  assert.equal(rows.find(row => row.name === 'JEV_API_KEY').note, 'JEV 的 API 密钥', '没存说明时用推导')

  const tricky = "JEV 生产环境密钥：含空格 与:冒号 和'引号'"
  rows = (await service.setNote('JEV_API_KEY', tricky)).refs
  assert.equal(rows.find(row => row.name === 'JEV_API_KEY').note, tricky, '存下的说明必须原样读回')

  rows = (await service.set('NEW_KEY', SECRET, '新增时一起写说明')).refs
  assert.equal(rows.find(row => row.name === 'NEW_KEY').note, '新增时一起写说明')

  rows = (await service.rename('JEV_API_KEY', 'JEV_PROD_KEY')).refs
  assert.deepEqual(rows.map(row => row.name).sort(), ['JEV_PROD_KEY', 'NEW_KEY', 'VPS_ROOT_PASSWORD'])
  assert.equal(rows.find(row => row.name === 'JEV_PROD_KEY').note, tricky, '改名要带走说明')

  rows = (await service.setNote('JEV_PROD_KEY', '')).refs
  assert.equal(rows.find(row => row.name === 'JEV_PROD_KEY').note, 'JEV PROD 的密钥', '清空说明回落推导')

  await assert.rejects(() => service.rename('VPS_ROOT_PASSWORD', 'JEV_PROD_KEY'), /已存在/)
  await assert.rejects(() => service.setNote('NOPE', 'x'), /不存在/)
  await assert.rejects(() => service.setNote('bad name', 'x'), /不合法/)

  rows = (await service.unset('JEV_PROD_KEY')).refs
  assert.deepEqual(rows.map(row => row.name).sort(), ['NEW_KEY', 'VPS_ROOT_PASSWORD'])
  assert.equal((await readFile(notesPath, 'utf8')).includes('JEV'), false, '删除凭据要同时删说明')
  await rm(dir, { recursive: true, force: true })
})

/* ------------------------------------------------------------------ report */

process.stdout.write(`dsh-secret self-check\n${results.join('\n')}\n`)
process.stdout.write(process.exitCode === 1 ? 'RESULT: FAILURES\n' : 'RESULT: all passed\n')
