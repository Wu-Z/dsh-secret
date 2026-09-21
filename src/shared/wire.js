/**
 * Wire vocabulary for the `secretManager` Remote namespace, shared by the host
 * Typert manifest (`src/host/typert.js`) and the browser contribution
 * (`src/client/remote.js`).
 *
 * One invocation list serves both halves, so the wire ids, parameter wires, and
 * result codecs physically cannot drift apart.
 */

import { z } from 'zod'

/**
 * One codec entry, in the shape the Typert gateway reads.
 * @param typeSymbol - stable per-codec symbol, namespaced by the package.
 * @param schema - the zod schema describing the JSON payload.
 * @returns the codec descriptor.
 */
export function codec(typeSymbol, schema) {
  return { mode: 'strict', typeSymbol: `dsh-secret#${typeSymbol}`, schema }
}

/** One credential row as the panel renders it — never a value. */
const refRowSchema = z.object({
  name: z.string(),
  configured: z.boolean(),
  source: z.string().optional(),
  writable: z.boolean(),
  /** Chinese label: the stored one, else the derived fallback. */
  note: z.string(),
})

/** The whole list, returned by every method so one round trip refreshes the panel. */
export const refListSchema = z.object({ refs: z.array(refRowSchema) })

const refListCodec = codec('RefList', refListSchema)
const refNameCodec = codec('RefName', z.string())
const secretValueCodec = codec('SecretValue', z.string())
const noteCodec = codec('Note', z.string())

/** The three methods the panel calls, mirrored by the host service's own methods. */
export const INVOCATIONS = [
  {
    id: 'dsh-secret#secretManager/list',
    service: 'secretManager',
    namespace: 'secretManager',
    method: 'list',
    invocation: { kind: 'direct' },
    parameters: [],
    result: refListCodec,
  },
  {
    id: 'dsh-secret#secretManager/set',
    service: 'secretManager',
    namespace: 'secretManager',
    method: 'set',
    invocation: { kind: 'direct' },
    parameters: [
      { name: 'ref', wire: 'ref', source: 'json', codec: refNameCodec },
      { name: 'value', wire: 'value', source: 'json', codec: secretValueCodec },
      { name: 'note', wire: 'note', source: 'json', codec: noteCodec },
    ],
    result: refListCodec,
  },
  {
    id: 'dsh-secret#secretManager/unset',
    service: 'secretManager',
    namespace: 'secretManager',
    method: 'unset',
    invocation: { kind: 'direct' },
    parameters: [{ name: 'ref', wire: 'ref', source: 'json', codec: refNameCodec }],
    result: refListCodec,
  },
  {
    id: 'dsh-secret#secretManager/setNote',
    service: 'secretManager',
    namespace: 'secretManager',
    method: 'setNote',
    invocation: { kind: 'direct' },
    parameters: [
      { name: 'ref', wire: 'ref', source: 'json', codec: refNameCodec },
      { name: 'note', wire: 'note', source: 'json', codec: noteCodec },
    ],
    result: refListCodec,
  },
  {
    id: 'dsh-secret#secretManager/rename',
    service: 'secretManager',
    namespace: 'secretManager',
    method: 'rename',
    invocation: { kind: 'direct' },
    parameters: [
      { name: 'from', wire: 'from', source: 'json', codec: refNameCodec },
      { name: 'to', wire: 'to', source: 'json', codec: refNameCodec },
    ],
    result: refListCodec,
  },
]
