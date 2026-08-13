/**
 * The policy kernel: the doctrine as running code.
 *
 * It owns the session's phase, runs the guards, and answers the engine's
 * permission requests. The guards share one typed state object here rather than
 * each deriving the same facts from the transcript, which is what five separate
 * scripts used to do.
 *
 * Two rules shape everything below.
 *
 * A guard may never take down the session. Every call into a guard is trapped,
 * and a guard that throws is switched off with the failure recorded and shown,
 * because standing order 1 says unmeasured reads as broken and therefore has to
 * look broken rather than quietly stop happening.
 *
 * The kernel decides, but it does not approve. It can refuse a call outright
 * and it can correct one, and anything it merely objects to travels to the
 * human with the objection attached. Approval belongs to Aaron.
 */
import {
  EDIT_TOOLS,
  MODEL_BY_TIER,
  TIER_BY_PHASE,
  initialSessionState,
  type Guard,
  type GuardNote,
  type KernelEvent,
  type KernelHealth,
  type PermissionMode,
  type Phase,
  type SessionState,
  type ToolCall,
} from '../types.ts';

/** What the kernel needs from the engine, narrowed so tests can fake it. */
export interface EngineControls {
  setModel(model: string | undefined): Promise<void>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
}

export interface ApprovalRequest {
  call: ToolCall;
  /** Guard objections, shown against the thing they are about. */
  notes: GuardNote[];
  /** True when this request is a plan being approved rather than a tool running. */
  isPlanApproval: boolean;
}

export type ApprovalDecision =
  | { allow: true; input?: Record<string, unknown> }
  | { allow: false; reason: string };

export type ApprovalHandler = (request: ApprovalRequest) => Promise<ApprovalDecision>;

export interface KernelOptions {
  cwd: string;
  controls: EngineControls;
  approve: ApprovalHandler;
  /** Kernel commentary for the conversation stream. */
  onNote: (note: GuardNote) => void;
  guards?: Guard[];
}

export const PLAN_TOOL = 'ExitPlanMode';

export class Kernel {
  readonly state: SessionState;
  private readonly guards: Guard[];
  private readonly controls: EngineControls;
  private readonly approve: ApprovalHandler;
  private readonly onNote: (note: GuardNote) => void;
  private readonly disabled = new Set<string>();
  private readonly failures: string[] = [];

  constructor(options: KernelOptions) {
    this.state = initialSessionState(options.cwd);
    this.guards = options.guards ?? [];
    this.controls = options.controls;
    this.approve = options.approve;
    this.onNote = options.onNote;
  }

  get health(): KernelHealth {
    return {
      healthy: this.failures.length === 0,
      disabled: [...this.disabled],
      failures: [...this.failures],
    };
  }

  /** The model this phase requires, or null when the phase does not care. */
  requiredModel(phase: Phase = this.state.phase): string | null {
    const tier = TIER_BY_PHASE[phase];
    return tier ? MODEL_BY_TIER[tier] : null;
  }

  private fail(guard: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const line = `${guard}: ${message}`;
    if (!this.failures.includes(line)) this.failures.push(line);
    // Switched off rather than retried. A guard that throws once will throw
    // again on the next call, and a loop of failures would bury the report.
    this.disabled.add(guard);
    this.onNote({
      guard,
      severity: 'blocking',
      message:
        `${guard} failed and has been switched off for this session (${message}). ` +
        'Whatever it checks is now UNCHECKED, which is not the same as fine.',
    });
  }

  /** Tell every guard what happened. Never throws. */
  observe(event: KernelEvent): void {
    for (const guard of this.guards) {
      if (this.disabled.has(guard.name) || !guard.observe) continue;
      try {
        guard.observe(event, this.state);
      } catch (error) {
        this.fail(guard.name, error);
      }
    }
  }

  // ---------------------------------------------------------------- phases

  /**
   * Enter planning, which sets the permission mode and the model together.
   *
   * The whole project exists for these two lines. The hook this replaces could
   * only refuse the turn and print the command for Aaron to type.
   */
  async enterPlanning(): Promise<void> {
    await this.setPhase('planning');
    await this.controls.setPermissionMode('plan');
  }

  /** Leave planning without a plan having been approved. */
  async leavePlanning(mode: PermissionMode = 'default'): Promise<void> {
    await this.setPhase('conversation');
    await this.controls.setPermissionMode(mode);
  }

  private async setPhase(next: Phase): Promise<void> {
    const from = this.state.phase;
    if (from === next) return;
    this.state.phase = next;
    // Planning again ends whatever implementation phase was running. Without
    // this the two rules would ask for different models at the same moment,
    // which is the deadlock the Python gate needed three separate fixes for.
    if (next === 'planning') this.state.planApproved = false;
    this.observe({ type: 'phase-change', from, to: next });

    // An explicit model override outranks the router until it is cleared, so
    // that asking for a model and being overruled by policy cannot happen.
    if (this.state.modelOverride) return;
    const wanted = this.requiredModel(next);
    if (!wanted || wanted === this.state.selectedModel) return;
    await this.controls.setModel(wanted);
    this.state.selectedModel = wanted;
  }

  /** Pin a model by hand. Survives phase changes until cleared. */
  async overrideModel(model: string | null): Promise<void> {
    this.state.modelOverride = model;
    if (model) {
      await this.controls.setModel(model);
      this.state.selectedModel = model;
      return;
    }
    const wanted = this.requiredModel();
    if (wanted) {
      await this.controls.setModel(wanted);
      this.state.selectedModel = wanted;
    }
  }

  recordServingModel(model: string | null): void {
    if (model) this.state.servingModel = model;
  }

  /** True when the model answering is not the one that was asked for. */
  get rerouted(): boolean {
    const { selectedModel, servingModel } = this.state;
    if (!selectedModel || !servingModel) return false;
    return selectedModel.split('[')[0] !== servingModel.split('[')[0];
  }

  // ---------------------------------------------------------------- tools

  /**
   * Answer the engine's permission request.
   *
   * A refusal from a guard ends it here. Everything else reaches Aaron, with
   * any objections attached, because approval is his.
   */
  async decide(call: ToolCall): Promise<ApprovalDecision> {
    let input = call.input;
    const notes: GuardNote[] = [];

    for (const guard of this.guards) {
      if (this.disabled.has(guard.name) || !guard.decide) continue;
      let decision;
      try {
        decision = guard.decide({ ...call, input }, this.state);
      } catch (error) {
        this.fail(guard.name, error);
        continue;
      }

      if (decision.kind === 'deny') {
        return { allow: false, reason: decision.reason };
      }
      if (decision.kind === 'modify') {
        input = decision.input;
        this.onNote({ guard: guard.name, severity: 'info', message: decision.note });
      }
      if (decision.kind === 'annotate') {
        notes.push(...decision.notes);
      }
    }

    const isPlanApproval = call.toolName === PLAN_TOOL;
    const result = await this.approve({ call: { ...call, input }, notes, isPlanApproval });

    if (!result.allow) return result;

    if (isPlanApproval) {
      await this.startImplementation();
    }
    // A guard's correction has to survive the approval. The handler only
    // supplies input of its own when the human edited the call.
    if (!result.input && input !== call.input) {
      return { allow: true, input };
    }
    return result;
  }

  /** Plan approved, so implementation begins and the model follows it. */
  async startImplementation(): Promise<void> {
    this.state.planApproved = true;
    await this.setPhase('implementation');
  }

  /** Whether this call is an edit made during approved implementation work. */
  isImplementationEdit(call: ToolCall): boolean {
    return (
      this.state.planApproved &&
      this.state.phase === 'implementation' &&
      (EDIT_TOOLS as readonly string[]).includes(call.toolName)
    );
  }
}
