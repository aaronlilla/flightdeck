/**
 * Shared vocabulary for flightdeck.
 *
 * Nothing in this file imports the SDK. The engine adapter is the only module
 * allowed to do that, and it translates SDK shapes into the types here so that
 * an SDK API change has a one file blast radius.
 */

/** Which phase of work the session is in. Research happens inside subagents. */
export type Phase = 'conversation' | 'planning' | 'implementation';

/** The three tiers standing order 17 routes work to. */
export type Tier = 'plan' | 'implementation' | 'research';

export const MODEL_BY_TIER: Record<Tier, string> = {
  plan: 'claude-fable-5',
  implementation: 'claude-opus-5',
  research: 'claude-sonnet-5',
};

/** Short names accepted by the model picker, kept for messages and commands. */
export const ALIAS_BY_TIER: Record<Tier, string> = {
  plan: 'fable',
  implementation: 'opus',
  research: 'sonnet',
};

export type PermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'plan'
  | 'dontAsk'
  | 'auto';

/**
 * Which model each phase requires. The conversation phase requires nothing,
 * because policing one line fixes and ordinary discussion is the behaviour the
 * old hook deliberately avoided.
 */
export const TIER_BY_PHASE: Record<Phase, Tier | null> = {
  conversation: null,
  planning: 'plan',
  implementation: 'implementation',
};

/** Tier for each subagent type. Anything unlisted is research, which is cheap. */
export const TIER_BY_SUBAGENT: Record<string, Tier> = {
  Plan: 'plan',
  Explore: 'research',
  'general-purpose': 'research',
  'claude-code-guide': 'research',
  'statusline-setup': 'research',
};

export const DEFAULT_SUBAGENT_TIER: Tier = 'research';

/** Tools that write to disk. */
export const EDIT_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'] as const;

/**
 * Everything a guard is allowed to know about the session.
 *
 * One shared object rather than five scripts each re-deriving the same facts
 * from the transcript tail.
 */
export interface SessionState {
  sessionId: string | null;
  phase: Phase;
  /** The model flightdeck asked for. */
  selectedModel: string | null;
  /**
   * The model that answered the most recent turn. Usually the same as
   * selectedModel. It differs when the safety layer reroutes a session, which
   * is the condition the status bar shows in red.
   */
  servingModel: string | null;
  permissionMode: PermissionMode;
  /** True once a plan has been approved and implementation has begun. */
  planApproved: boolean;
  /** Set by the user with an explicit model command; outranks the router. */
  modelOverride: string | null;
  cwd: string;
  turnCount: number;
}

export function initialSessionState(cwd: string): SessionState {
  return {
    sessionId: null,
    phase: 'conversation',
    selectedModel: null,
    servingModel: null,
    permissionMode: 'default',
    planApproved: false,
    modelOverride: null,
    cwd,
    turnCount: 0,
  };
}

/** A tool call as the kernel sees it, before the engine runs it. */
export interface ToolCall {
  toolName: string;
  input: Record<string, unknown>;
  /** Prompt text the engine rendered for this request, when it supplied one. */
  prompt?: string;
}

/**
 * What a guard can say about a tool call.
 *
 * `annotate` is the decision that distinguishes this kernel from the hook it
 * replaces: the call proceeds, and the note travels to the approval screen so
 * the human sees the objection at the moment of deciding.
 */
export type GuardDecision =
  | { kind: 'pass' }
  | { kind: 'deny'; reason: string }
  | { kind: 'modify'; input: Record<string, unknown>; note: string }
  | { kind: 'annotate'; notes: GuardNote[] };

export interface GuardNote {
  /** Guard that raised it, used as the label in the interface. */
  guard: string;
  severity: 'blocking' | 'warning' | 'info';
  message: string;
}

/** Events a guard may observe even when it has no say over a tool call. */
export type KernelEvent =
  | { type: 'prompt'; text: string }
  | { type: 'assistant-text'; text: string }
  | { type: 'turn-complete'; model: string | null }
  | { type: 'phase-change'; from: Phase; to: Phase };

export interface Guard {
  /** Stable identifier, used by kill switches and in interface labels. */
  readonly name: string;
  /** Called for lifecycle events. Never throws to the caller; the kernel traps. */
  observe?(event: KernelEvent, state: SessionState): void;
  /** Called before a tool runs. Absent means the guard has no opinion on tools. */
  decide?(call: ToolCall, state: SessionState): GuardDecision;
}

/** Health of the enforcement layer, surfaced in the status bar. */
export interface KernelHealth {
  /** False once any guard has thrown. Standing order 1: unmeasured reads broken. */
  healthy: boolean;
  /** Guards switched off, either by configuration or by having crashed. */
  disabled: string[];
  /** One line per distinct failure, shown once rather than on every turn. */
  failures: string[];
}
