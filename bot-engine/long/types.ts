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
}

export interface LongBotEngineOptions {
  weights?: Partial<LongBotWeights>;
  maxCandidates?: number;
  timeLimitMs?: number;
}
