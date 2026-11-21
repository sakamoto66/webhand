export function decide(input: unknown): {
  hookSpecificOutput: { hookEventName: string; permissionDecision: string; permissionDecisionReason: string };
} | null;
