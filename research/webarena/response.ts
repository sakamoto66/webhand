/** FinalAgentResponse schema validation for WebArena-Verified. */

import { WebArenaError } from "./sites.ts";

const TASK_TYPES = ["RETRIEVE", "MUTATE", "NAVIGATE"] as const;
type TaskType = (typeof TASK_TYPES)[number];

const AGENT_STATUSES = [
  "SUCCESS",
  "ACTION_NOT_ALLOWED_ERROR",
  "PERMISSION_DENIED_ERROR",
  "NOT_FOUND_ERROR",
  "DATA_VALIDATION_ERROR",
  "UNKNOWN_ERROR",
] as const;
type AgentStatus = (typeof AGENT_STATUSES)[number];

interface FinalAgentResponse {
  task_type: TaskType;
  status: AgentStatus;
  retrieved_data?: unknown[];
  error_details?: string;
}

/** Validates and normalizes a WebArena-Verified FinalAgentResponse object. */
export function validateAgentResponse(input: {
  taskType: string | null;
  status: string | null;
  retrievedDataRaw: string | null;
  errorDetails: string | null;
}): FinalAgentResponse {
  if (!input.taskType) {
    throw new WebArenaError(`--task-type is required (${TASK_TYPES.join(", ")})`);
  }
  const task_type = input.taskType.trim().toUpperCase() as TaskType;
  if (!(TASK_TYPES as readonly string[]).includes(task_type)) {
    throw new WebArenaError(`Invalid --task-type "${input.taskType}" (expected one of: ${TASK_TYPES.join(", ")})`);
  }

  if (!input.status) {
    throw new WebArenaError(`--wa-status is required (${AGENT_STATUSES.join(", ")})`);
  }
  const status = input.status.trim().toUpperCase() as AgentStatus;
  if (!(AGENT_STATUSES as readonly string[]).includes(status)) {
    throw new WebArenaError(`Invalid --wa-status "${input.status}" (expected one of: ${AGENT_STATUSES.join(", ")})`);
  }

  let retrieved_data: unknown[] | null = null;
  if (input.retrievedDataRaw !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(input.retrievedDataRaw);
    } catch (error) {
      throw new WebArenaError(`--retrieved-data must be valid JSON: ${(error as Error).message}`);
    }
    if (parsed !== null && !Array.isArray(parsed)) {
      throw new WebArenaError("--retrieved-data must be a JSON array (or null)");
    }
    retrieved_data = parsed;
  }

  if (task_type === "RETRIEVE") {
    if (status === "SUCCESS" && retrieved_data === null) {
      throw new WebArenaError("--retrieved-data (a JSON array, e.g. '[]') is required for RETRIEVE with SUCCESS");
    }
  } else if (retrieved_data !== null) {
    throw new WebArenaError(`--retrieved-data must be omitted or null for ${task_type} tasks`);
  }

  let error_details = input.errorDetails ? input.errorDetails.trim() : null;
  if (status === "SUCCESS") {
    if (error_details) {
      throw new WebArenaError("--error-details must be omitted when --wa-status is SUCCESS");
    }
    error_details = null;
  }

  // Omit null optional fields: webarena-verified 1.2.3's AgentResponseEvaluator calls .strip() on present error_details.
  return {
    task_type,
    status,
    ...(retrieved_data !== null ? { retrieved_data } : {}),
    ...(error_details !== null ? { error_details } : {}),
  };
}
