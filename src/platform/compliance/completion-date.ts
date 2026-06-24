/**
 * Validates and normalizes a user-entered HIPAA completion date.
 *
 * Rules (shared by every entry path): the string must be exactly YYYY-MM-DD,
 * a real calendar date, not in the future, and not older than 5 years. The
 * result is normalized to noon UTC to match the PDF parser convention, so a
 * date never shifts a day across time zones.
 */
export class CompletionDateError extends Error {
  constructor(public reason: string) {
    super(`Completion date validation failed: ${reason}`);
    this.name = "CompletionDateError";
  }
}

export function parseCompletionDate(dateIso: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateIso);
  if (!match) {
    throw new CompletionDateError(`invalid date "${dateIso}"; expected YYYY-MM-DD format`);
  }

  const year = parseInt(match[1], 10);
  const month0 = parseInt(match[2], 10) - 1;
  const day = parseInt(match[3], 10);

  const completionDate = new Date(Date.UTC(year, month0, day, 12, 0, 0, 0));

  // Reject calendar overflow (e.g. Feb 30 rolling into March).
  if (
    completionDate.getUTCFullYear() !== year ||
    completionDate.getUTCMonth() !== month0 ||
    completionDate.getUTCDate() !== day
  ) {
    throw new CompletionDateError(`invalid date "${dateIso}"`);
  }

  const now = new Date();
  // Ceiling is end-of-day UTC so entering today's date is always allowed,
  // regardless of the caller's time zone (completionDate is normalized to noon UTC).
  const endOfTodayUtc = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    23, 59, 59, 999
  );
  if (completionDate.getTime() > endOfTodayUtc) {
    throw new CompletionDateError("completion date cannot be in the future");
  }

  const cutoff = new Date(Date.UTC(
    now.getUTCFullYear() - 5,
    now.getUTCMonth(),
    now.getUTCDate(),
    12, 0, 0, 0
  ));
  if (completionDate.getTime() < cutoff.getTime()) {
    throw new CompletionDateError("completion date is too old (older than 5 years)");
  }

  return completionDate;
}
