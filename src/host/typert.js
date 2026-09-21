/**
 * The hand-written Typert manifest for the host face.
 *
 * The in-repo generator emits this shape from a decorated service; an
 * out-of-repo plugin writes it directly instead, which is why this package has
 * no codegen step. `zod` stays external (the profile resolves it next to this
 * file), and the invocation list is shared with the browser contribution.
 */

import { INVOCATIONS } from '../shared/wire.js'

/** Host FaceModel: the service behind the `secretManager` namespace. */
export const TYPERT = {
  package: 'dsh-secret',
  face: 'host',
  schemas: [],
  invocations: INVOCATIONS,
  model: {
    services: [
      {
        key: 'secretManager',
        exportName: 'secretManager',
        description: '密钥管理:列出、写入、改名、删除本机凭据存储里的条目,并维护它们的中文说明(永不回值)。',
        summary: 'List, store, rename, and remove credential-store entries, and edit their Chinese labels, for the management panel. Values never cross the wire.',
        jsDoc: '/** Credential-store management service behind the `secretManager` Remote namespace. */',
        tags: ['credentials', 'secrets', 'web'],
        members: [
          { name: 'list', kind: 'method', signature: 'list(): Promise<RefList>' },
          { name: 'set', kind: 'method', signature: 'set(ref: string, value: string, note: string): Promise<RefList>' },
          { name: 'setNote', kind: 'method', signature: 'setNote(ref: string, note: string): Promise<RefList>' },
          { name: 'rename', kind: 'method', signature: 'rename(from: string, to: string): Promise<RefList>' },
          { name: 'unset', kind: 'method', signature: 'unset(ref: string): Promise<RefList>' },
        ],
        types: [],
      },
    ],
    events: [],
    objects: [],
  },
}

export default TYPERT
