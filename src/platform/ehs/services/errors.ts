export class EhsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EhsValidationError";
  }
}
