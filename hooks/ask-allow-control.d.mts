export type HookDecision =
  | {
      hookSpecificOutput: { hookEventName: string; permissionDecision: string; permissionDecisionReason: string };
    }
  | {
      decision: "force_ask";
      reason: string;
    };

export function decide(input: unknown): HookDecision | null;
