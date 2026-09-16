export type LongBotColor = 'white' | 'dark';
export type LongBotVariant = 'long';

export interface LongBotPoint {
  color: LongBotColor;
  count: number;
}

export interface LongBotState {
  variant?: LongBotVariant | string;
  points: Record<string, LongBotPoint>;
  off?: Record<LongBotColor, number>;
  dice?: number[];
  rolled?: number[];
  turn?: LongBotColor | null;
  phase?: string;
  winner?: LongBotColor | null;
  resultType?: 'normal' | 'mars' | 'koks' | string | null;
}

export interface LongBotMove {
  from: number;
  die: number;
  to?: number;
  bearOff?: boolean;
}

export type LongBotSequence = LongBotMove[];

export interface LongBotRulesAdapter {
  legalSequences(state: LongBotState, color: LongBotColor): LongBotSequence[];
  applySequence(state: LongBotState, sequence: LongBotSequence, color: LongBotColor): LongBotState;
  moveTo(state: LongBotState, color: LongBotColor, from: number, die: number): number;
}

export interface LongBotWeights {
  progress: number;
  homeCheckers: number;
  borneOff: number;
  blockade: number;
  stuckRisk: number;
  distribution: number;
  tempo: number;
  bearOffPriority: number;
  headRelease: number;
  foothold: number;
  rushPenalty: number;
  homeEntry: number;
  trapRisk: number;
  headLandingExposure: number;
  opponentHeadFreedom: number;
  escapeGatewayRisk: number;
  koksRescue: number;
}

export interface LongBotEngineOptions {
  weights?: Partial<LongBotWeights>;
  maxCandidates?: number;
  analysisNodeBudget?: number;
  /** @deprecated Kept for older callers; search is bounded by analysisNodeBudget. */
  timeLimitMs?: number;
}

export interface LongBotTacticalAnalysis {
  expectedImpact: number;
  worstImpact: number;
  rolls: number;
  adjustment: number;
  recoveryExpected?: number;
  recoveryWorst?: number;
  recoveryRolls?: number;
  /** Recovery estimates are dice-complete only within one primary scenario. */
  recoveryModelKind?: 'conditional-single-primary-v1' | string;
  recoveryConditional?: boolean;
  /** Canonical high:low dice key, including doubles expanded to four moves. */
  recoveryPrimaryDiceKey?: string;
  recoveryPrimaryDiceWeight?: number;
  recoveryPrimaryFrontierCount?: number;
  recoveryTotalPrimaryFrontierCount?: number;
  recoveryPrimaryFrontierWeight?: number;
  recoveryTotalPrimaryFrontierWeight?: number;
  deepAdjustment?: number;
  continuationExpected?: number;
  continuationWorst?: number;
  continuationRolls?: number;
  /** Every next-roll outcome was expanded on each selected conditional proxy. */
  continuationModelComplete?: boolean;
  continuationModelKind?: 'representative-worst-proxy-v1' | string;
  /** Some real recovery-frontier dice mass was represented only by a proxy. */
  continuationApproximate?: boolean;
  /** Recovery-board coverage within the chosen primary scenario, not nested proof. */
  continuationCoverageComplete?: boolean;
  continuationFrontierCount?: number;
  /** Actual recovery dice mass of the unique sampled boards, not proxy mass. */
  continuationFrontierWeight?: number;
  continuationTotalFrontierCount?: number;
  continuationTotalFrontierWeight?: number;
  continuationProxyWeight?: number;
  continuationWorstRecoveryFrontierWeight?: number;
  /** Original recovery-roll provenance, before equal-board deduplication. */
  continuationRepresentativeDiceKey?: string;
  continuationRepresentativeDiceWeight?: number;
  /** Quadrature mass used in ranking, NOT the representative roll's mass. */
  continuationRepresentativeProxyWeight?: number;
  continuationWorstRecoveryDiceKey?: string;
  continuationWorstRecoveryDiceWeight?: number;
  continuationWorstRecoveryProxyWeight?: number;
  continuationRepresentativeFrontierIncluded?: boolean;
  continuationWorstFrontierIncluded?: boolean;
  continuationAdjustment?: number;
  plies?: number;
}

export interface LongBotExperienceDescriptor {
  contextKey: string;
  actionKey: string;
  strategicActionKey?: string;
  familyActionKey?: string;
  legacyActionKey?: string;
  behaviorActionKeys?: string[];
  mistakeSeverity: number;
  riskSignal?: number;
  phase: string;
}

export interface LongBotExperiencePattern {
  contextKey?: string;
  context_key?: string;
  actionKey?: string;
  action_key?: string;
  samples: number;
  losses: number;
  severeLosses?: number;
  severe_losses?: number;
  signalWeight?: number;
  signal_weight?: number;
}

export interface LongBotRankedCandidate {
  sequence: LongBotSequence;
  after: LongBotState;
  score: number;
  baseScore?: number;
  features: Record<string, number | string>;
  tactical?: LongBotTacticalAnalysis;
  experience?: LongBotExperienceDescriptor;
  experienceAdjustment?: number;
}
