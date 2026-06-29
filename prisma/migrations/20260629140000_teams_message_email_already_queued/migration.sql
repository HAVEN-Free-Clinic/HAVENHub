-- Issue #74: for channel "both" notify() queues the email up front AND a Teams
-- message carrying the same content as the email fallback. When Teams delivery
-- failed permanently, drainTeamsQueue queued the fallback email unconditionally,
-- with no record of whether the channel was "teams" or "both" -- so "both"
-- recipients got a duplicate email. Persist whether the email was already queued
-- so the permanent-failure fallback can skip it for "both".
--
-- Backfill: existing rows default to false. Any in-flight "both" rows queued
-- before this migration could still double-send on permanent failure, but that
-- is the prior (buggy) behavior and the email at least lands; no data fix needed.

-- AlterTable
ALTER TABLE "TeamsMessage" ADD COLUMN "emailAlreadyQueued" BOOLEAN NOT NULL DEFAULT false;
