import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ErrorClass = new (...args: any[]) => Error;

/**
 * Run a server-action body with the common error-to-redirect shape:
 * run work(); if it throws one of domainErrors, redirect to errorRedirect(message);
 * any other throw (including Next's redirect sentinel) propagates unchanged.
 * On success, revalidate the given path when provided.
 */
export async function runAction(opts: {
  work: () => Promise<unknown>;
  domainErrors: ErrorClass[];
  errorRedirect: (message: string) => string;
  revalidate?: string;
}): Promise<void> {
  try {
    await opts.work();
  } catch (err) {
    if (opts.domainErrors.some((E) => err instanceof E)) {
      redirect(opts.errorRedirect((err as Error).message));
    }
    throw err;
  }
  if (opts.revalidate) revalidatePath(opts.revalidate);
}
