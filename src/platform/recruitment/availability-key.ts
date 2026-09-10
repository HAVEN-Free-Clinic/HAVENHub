/**
 * The one application field whose options are owned by the term's clinic
 * calendar rather than by the form builder.
 *
 * Read by the form templates (to swap in the live calendar), by submission (to
 * normalize the answer), by promotion (to seed baselineAvailability), by the
 * incoming-roster query, and by the form builder's field card. It is one literal
 * because those five must agree about which answer holds availability.
 *
 * It lives in its own module, apart from the query and parser that use it, for
 * ONE reason: the form builder's FieldCard is a client component, and importing
 * this constant from incoming-roster.ts pulled that module's `prisma` import
 * into the browser bundle with it. `new PrismaClient()` throws on evaluation
 * there, so the whole form builder rendered a 200 and then died in a client
 * error boundary. Nothing that a client component imports may reach
 * platform/db.ts, and a bare string constant has no reason to.
 *
 * This is the same split, and the same reason, as service-record-format.ts.
 */
export const AVAILABILITY_FIELD_KEY = "availability";
