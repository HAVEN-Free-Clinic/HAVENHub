-- Hours one shift is worth, per department, for the volunteer service record.
-- Nullable on purpose: null means "not configured" and renders as "not
-- recorded", so no existing department starts claiming zero hours.
ALTER TABLE "Department" ADD COLUMN "hoursPerShift" DECIMAL(4,2);
