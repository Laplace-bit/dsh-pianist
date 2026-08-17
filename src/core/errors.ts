/** Error type for invalid scores. The player must reject, not guess. */
export class ScoreValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid score: ${issues.join('; ')}`);
    this.name = 'ScoreValidationError';
    this.issues = [...issues];
  }
}

export class ScoreParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScoreParseError';
  }
}
