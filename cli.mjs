#!/usr/bin/env node
/**
 * dsh-secret management CLI — add, replace, and remove stored credentials.
 *
 * This is the half of the plugin the USER drives. The secret is typed here, in
 * your own terminal, and never passes through the conversation, the model, or
 * the session log; the plugin's `secret_run` tool is the half the AGENT drives,
 * and it can only consume a name you already stored.
 *
 *   node cli.mjs list
 *   node cli.mjs set DB_PASSWORD          # hidden prompt
 *   printf '%s' "$PW" | node cli.mjs set DB_PASSWORD --stdin
 *   node cli.mjs del DB_PASSWORD
 *
 * There is deliberately no `get`: printing a secret to a terminal puts it into
 * the shell's scrollback and history. Read the file yourself if you really need
 * the plaintext back.
 *
 * Writes are line-targeted (see store-edit.mjs), atomic (temp file + rename),
 * and forced to 0600.
 */

import { chmod, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createInterface } from 'node:readline'
import { Writable } from 'node:stream'
import { assertEditable, deleteRef, isRefName, parseRefNames, setRefValue, storePath } from './store-edit.mjs'

const USAGE = `dsh-secret — 密码管理

  node cli.mjs list                     列出已存的凭据名
  node cli.mjs set <名字>                新增或修改（隐藏输入，不回显）
  node cli.mjs set <名字> --stdin        值从管道读入（脚本用）
  node cli.mjs del <名字>                删除

环境变量：
  DSH_SECRET_STORE   覆盖存储文件路径（默认 $DSH_HOME/.credentials.yaml）
`

/** Resolve the store path, honouring the CLI's own override for scripts/tests. */
function resolvePath() {
  const override = process.env.DSH_SECRET_STORE
  if (typeof override === 'string' && override.length > 0) return override
  return storePath(undefined)
}

async function readStore(path) {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === 'ENOENT') return ''
    throw error
  }
}

/** Atomic, owner-only write: temp file in the same directory, then rename. */
async function writeStore(path, text) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}`
  await writeFile(temporary, text, { mode: 0o600 })
  await rename(temporary, path)
  await chmod(path, 0o600)
}

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '')
}

/** Prompt without echoing: readline writes to a muted stream, so keys never show. */
async function promptHidden(label) {
  if (process.stdin.isTTY !== true) {
    throw new Error('当前不是交互终端：请用 --stdin 从管道传入密码')
  }
  const muted = new Writable({ write(_chunk, _encoding, callback) { callback() } })
  const rl = createInterface({ input: process.stdin, output: muted, terminal: true })
  try {
    process.stdout.write(label)
    const answer = await new Promise(resolve => { rl.question('', resolve) })
    process.stdout.write('\n')
    return answer
  } finally {
    rl.close()
  }
}

/** Warn when the document is readable beyond its owner. */
async function modeWarning(path) {
  try {
    const info = await stat(path)
    const widened = (info.mode & 0o077) !== 0
    return widened ? `⚠ ${path} 的权限是 ${(info.mode & 0o777).toString(8)}，建议 chmod 600` : ''
  } catch {
    return ''
  }
}

async function commandList(path) {
  const text = await readStore(path)
  const names = parseRefNames(text)
  if (names.length === 0) {
    process.stdout.write(`凭据存储里没有条目（${path}）\n`)
  } else {
    process.stdout.write(`${names.length} 条凭据（只列名字）：\n`)
    for (const name of names) process.stdout.write(`  ${name}\n`)
  }
  const warning = await modeWarning(path)
  if (warning !== '') process.stdout.write(`${warning}\n`)
  return 0
}

async function commandSet(path, name, useStdin) {
  if (!isRefName(name)) throw new Error(`凭据名不合法：${JSON.stringify(name)}（须匹配 [A-Za-z_][A-Za-z0-9_]*）`)
  const text = await readStore(path)
  assertEditable(text)
  const existed = parseRefNames(text).includes(name)

  const value = useStdin ? await readStdin() : await promptHidden(`输入 ${name} 的值（不回显）：`)
  if (value.length === 0) throw new Error('密码为空，未写入')

  const next = setRefValue(text, name, value)
  // Sanity check before touching the file: the edit must produce the name.
  if (!parseRefNames(next).includes(name)) throw new Error('内部校验失败：改写后的文档里找不到该名字，已放弃写入')
  await writeStore(path, next)

  process.stdout.write(`${existed ? '已更新' : '已新增'} ${name}（${value.length} 字符）→ ${path}\n`)
  const warning = await modeWarning(path)
  if (warning !== '') process.stdout.write(`${warning}\n`)
  return 0
}

async function commandDelete(path, name) {
  if (!isRefName(name)) throw new Error(`凭据名不合法：${JSON.stringify(name)}（须匹配 [A-Za-z_][A-Za-z0-9_]*）`)
  const text = await readStore(path)
  if (text.trim().length === 0) throw new Error('凭据存储还是空的，没有可删的条目')
  assertEditable(text)

  const { text: next, removed } = deleteRef(text, name)
  if (!removed) {
    process.stdout.write(`没有 ${name}，什么都没改\n`)
    return 0
  }
  if (parseRefNames(next).includes(name)) throw new Error('内部校验失败：删除后该名字仍在，已放弃写入')
  await writeStore(path, next)
  process.stdout.write(`已删除 ${name} → ${path}\n`)
  return 0
}

async function main(argv) {
  const [command, ...rest] = argv
  const path = resolvePath()

  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(USAGE)
    return command === undefined ? 2 : 0
  }
  if (command === 'list') return commandList(path)
  if (command === 'set' || command === 'del') {
    const name = rest.find(argument => !argument.startsWith('--'))
    if (name === undefined) {
      process.stderr.write(`缺少名字。\n\n${USAGE}`)
      return 2
    }
    if (command === 'set') return commandSet(path, name, rest.includes('--stdin'))
    return commandDelete(path, name)
  }

  process.stderr.write(`不认识的命令：${command}\n\n${USAGE}`)
  return 2
}

try {
  process.exitCode = await main(process.argv.slice(2))
} catch (error) {
  process.stderr.write(`错误：${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
