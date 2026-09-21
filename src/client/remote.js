/** Browser-side Remote contribution for the `secretManager` namespace. */

import { INVOCATIONS } from '../shared/wire.js'

/**
 * Mirrors the host Typert manifest: mounting it is what lets
 * `ctx.remote.secretManager.*` be called from this bundle.
 */
export const REMOTE_CONTRIBUTION = {
  package: 'dsh-secret',
  descriptors: INVOCATIONS,
}
