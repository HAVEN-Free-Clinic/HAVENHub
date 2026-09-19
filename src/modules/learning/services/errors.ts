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

/** A training makeup course opened by someone who does not owe the makeup
 *  (they attended, their department is excused, or they are not a member).
 *  Distinct from LearningAuthError so the page can explain rather than 404. */
export class MakeupNotOwedError extends LearningAuthError {
  constructor() {
    super("This course is only for members who missed the in-person training.");
    this.name = "MakeupNotOwedError";
  }
}

/** The makeup is locked after too many failed quiz attempts; a director resets
 *  it from the training roster. */
export class MakeupLockedError extends Error {
  constructor() {
    super("Your makeup is locked. Ask your director to reset it.");
    this.name = "MakeupLockedError";
  }
}
