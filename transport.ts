import type { SupabaseClient } from '@supabase/supabase-js';
import type { Mutation } from './outbox';
import { RetryableError, type ApplyResult, type Transport } from './sync';

export type ErrorClass = 'offline' | 'auth' | 'server' | 'permanent';
/** Decide whether an error says "try again later" or "this change will never be accepted". */
export function classify(status: number | undefined, err: { message?: string; code?: string }): ErrorClass {
  const msg = err.message ?? '';
  if ((!status || status === 0) && /fetch|network|load failed|offline|abort/i.test(msg)) return 'offline';
  if (typeof navigator !== 'undefined' && navigator.onLine === false && !status) return 'offline';
  if (status === 401 || err.code === 'PGRST301' || /jwt/i.test(msg)) return 'auth';
  if (status === 408 || status === 425 || status === 429 || (status !== undefined && status >= 500)) return 'server';
  if (!status) return 'server';
  return 'permanent';
}

export function supabaseTransport(supabase: SupabaseClient): Transport {
  return {
    async apply(m: Mutation): Promise<ApplyResult> {
      const { data: { session } } = await supabase.auth.getSession();
      // Never push one account's queued work under another account's session.
      if (!session || session.user.id !== m.userId) throw new RetryableError('auth', 'signed out or a different account is active');
      let res;
      try {
        res = await supabase.rpc('apply_mutation', {
          p_op_id: m.opId, p_entity: m.entity, p_kind: m.kind, p_id: m.entityId, p_workspace_id: m.workspaceId,
          p_base_version: m.baseVersion, p_payload: m.payload,
        });
      } catch (e) { throw new RetryableError('offline', e instanceof Error ? e.message : String(e)); }
      if (res.error) {
        const c = classify(res.status, res.error);
        if (c === 'permanent') return { status: 'rejected', reason: res.error.message };
        throw new RetryableError(c, res.error.message);
      }
      return res.data as ApplyResult;
    },
  };
}
