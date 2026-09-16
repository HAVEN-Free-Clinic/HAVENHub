-- A volunteer may hold more than one dual appointment (three departments in
-- total, counting the one their application was routed to).
--
-- The dropped index enforced exactly ONE pending-or-approved dual appointment
-- per application, which is the rule being relaxed. A partial unique index
-- cannot express "at most two", so the cap now lives in the service
-- (MAX_APPOINTED_DEPARTMENTS), which re-checks it inside a transaction that
-- locks the Application row -- the row lock, not a unique violation, is what
-- makes two concurrent requests serialize.
DROP INDEX IF EXISTS "DualAppointment_one_active_per_application";
