import { after } from "next/server";

/**
 * Run best-effort work after the response is sent, without the function being
 * frozen under it.
 *
 * A bare `void work()` started just before `return new Response(...)` is not
 * safe on Vercel: once the response is returned the invocation may be suspended,
 * and the pending query dies with "Server has closed the connection". after()
 * keeps the invocation alive until the callback settles.
 *
 * after() throws outside a request scope (unit tests calling a route's GET()
 * directly, scripts), which once broke five tests (#301/#302). Same guard as
 * createEnqueueFlusher: catch that and, since there is no response to wait for,
 * just start the work now. `task` must handle its own errors; a rejection here
 * has nowhere useful to go.
 */
export function runAfterResponse(task: () => Promise<void>): void {
  try {
    after(task);
  } catch {
    void task();
  }
}
