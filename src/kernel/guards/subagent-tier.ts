/**
 * Standing order 17, applied to subagents.
 *
 * Every Agent call runs on the tier its work belongs to: planning on Fable,
 * implementation on Opus, research and exploration on Sonnet.
 *
 * This is the clearest example of what the kernel can do that the hook could
 * not. The hook denied a call whose model was wrong and made the model issue it
 * again, which cost a turn and taught nothing. A permission decision can return
 * modified input, so here the model is simply corrected on the way through. The
 * wrong call stops being possible instead of being punished.
 */
import {
  ALIAS_BY_TIER,
  DEFAULT_SUBAGENT_TIER,
  MODEL_BY_TIER,
  TIER_BY_SUBAGENT,
  type Guard,
  type GuardDecision,
  type Tier,
  type ToolCall,
} from '../../types.ts';

export function tierFor(subagentType: string | undefined): Tier {
  if (!subagentType) return DEFAULT_SUBAGENT_TIER;
  return TIER_BY_SUBAGENT[subagentType] ?? DEFAULT_SUBAGENT_TIER;
}

/** True when the requested model already names the tier it should run on. */
export function modelMatchesTier(model: unknown, tier: Tier): boolean {
  if (typeof model !== 'string' || !model) return false;
  const base = model.split('[')[0]?.trim() ?? '';
  if (base === MODEL_BY_TIER[tier] || base === ALIAS_BY_TIER[tier]) return true;
  // Implementation is a tier rather than a point release, so any Opus counts.
  // The safety layer can move a session onto an older Opus without asking, and
  // holding out for the exact version would reject work for a reason outside
  // anyone's control. Planning stays pinned, because widening it would let a
  // rerouted turn plan on whatever the reroute picked.
  return tier === 'implementation' && /^claude-opus-[0-9]/.test(base);
}

export const subagentTierGuard: Guard = {
  name: 'subagent-tier',

  decide(call: ToolCall): GuardDecision {
    if (call.toolName !== 'Agent') return { kind: 'pass' };

    const subagentType =
      typeof call.input['subagent_type'] === 'string' ? call.input['subagent_type'] : undefined;
    const tier = tierFor(subagentType);
    const requested = call.input['model'];

    if (modelMatchesTier(requested, tier)) return { kind: 'pass' };

    const alias = ALIAS_BY_TIER[tier];
    const had = typeof requested === 'string' && requested ? `was ${requested}` : 'named no model';
    return {
      kind: 'modify',
      input: { ...call.input, model: alias },
      note:
        `Subagent ${subagentType ?? '(default)'} belongs on ${alias}, and the call ${had}. ` +
        'Corrected on the way through rather than refused.',
    };
  },
};
