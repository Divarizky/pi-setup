/**
 * Agent Control policy prototype.
 *
 * This module intentionally contains only deterministic decisions. It does not
 * run commands, inspect Git, or mutate task state. Later task-control layers
 * consume these decisions instead of rediscovering delivery policy ad hoc.
 */

export const DELIVERY_POLICY_DECISIONS = {
  validationCommands: {
    minimum: 1,
    maximum: 5,
    execution: "sequential-fail-fast",
  },
  scopeOverlap: {
    defaultDecision: "blocked",
    humanOverride: "explicit-only",
    modelOverride: false,
  },
  integrationValidation: {
    source: "candidate-validation",
    separateProjectCommands: false,
    execution: "sequential-fail-fast",
  },
  retention: {
    automaticExpiry: false,
    cleanup: "explicit-administrative-action",
  },
  rejectedBranch: {
    action: "preserve",
    uiDeletion: false,
    cleanup: "explicit-administrative-action",
  },
} as const;

export type ValidationPlan =
  | {
      accepted: true;
      commands: string[];
      execution: "sequential-fail-fast";
    }
  | {
      accepted: false;
      commands: string[];
      execution: "sequential-fail-fast";
      reason: string;
    };

/**
 * Validate the MVP command-count policy. Execution itself belongs to the
 * validation runner; this function only returns the executable plan.
 */
export function planValidationCommands(commands: readonly string[]): ValidationPlan {
  const plannedCommands = [...commands];

  if (plannedCommands.length < DELIVERY_POLICY_DECISIONS.validationCommands.minimum) {
    return {
      accepted: false,
      commands: plannedCommands,
      execution: "sequential-fail-fast",
      reason: "A ship task must define at least one validation command.",
    };
  }

  if (plannedCommands.length > DELIVERY_POLICY_DECISIONS.validationCommands.maximum) {
    return {
      accepted: false,
      commands: plannedCommands,
      execution: "sequential-fail-fast",
      reason: "A ship task may define at most five validation commands.",
    };
  }

  return {
    accepted: true,
    commands: plannedCommands,
    execution: "sequential-fail-fast",
  };
}

export interface ScopeOverlapInput {
  overlaps: boolean;
  humanOverride: boolean;
}

export type ScopeOverlapDecision =
  | {
      decision: "allowed";
      reason: "Ship scopes do not overlap.";
    }
  | {
      decision: "blocked";
      reason: "Overlapping ship scopes require an explicit human override.";
    }
  | {
      decision: "allowed-with-human-override";
      reason: "Overlap was explicitly approved by the human operator.";
    };

export function decideScopeOverlap(input: ScopeOverlapInput): ScopeOverlapDecision {
  if (!input.overlaps) {
    return {
      decision: "allowed",
      reason: "Ship scopes do not overlap.",
    };
  }

  if (!input.humanOverride) {
    return {
      decision: "blocked",
      reason: "Overlapping ship scopes require an explicit human override.",
    };
  }

  return {
    decision: "allowed-with-human-override",
    reason: "Overlap was explicitly approved by the human operator.",
  };
}

export type IntegrationValidationPlan = ValidationPlan & {
  source: "candidate-validation";
};

/**
 * Reuse the candidate validation plan after merge. There is deliberately no
 * second project-level command list in the MVP decision.
 */
export function planIntegrationValidation(
  candidateCommands: readonly string[],
): IntegrationValidationPlan {
  return {
    ...planValidationCommands(candidateCommands),
    source: "candidate-validation",
  };
}

export type RetainedArtifact = "task" | "event" | "candidate";

export function getRetentionDecision(artifact: RetainedArtifact): {
  artifact: RetainedArtifact;
  automaticExpiry: false;
  action: "retain";
  cleanup: "explicit-administrative-action";
} {
  return {
    artifact,
    automaticExpiry: false,
    action: "retain",
    cleanup: "explicit-administrative-action",
  };
}

export function rejectedBranchDecision(): {
  action: "preserve";
  uiDeletion: false;
  cleanup: "explicit-administrative-action";
} {
  return {
    action: "preserve",
    uiDeletion: false,
    cleanup: "explicit-administrative-action",
  };
}
