export class LearningAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LearningAuthError";
  }
}

export class LearningValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LearningValidationError";
  }
}
