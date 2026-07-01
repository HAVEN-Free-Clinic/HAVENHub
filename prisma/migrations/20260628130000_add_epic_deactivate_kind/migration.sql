-- Add the DEACTIVATE value to the EpicRequestKind enum so offboarding can
-- enqueue a tracked Epic access revocation task and the ITCM generator can
-- produce YNHH deactivation service requests.
ALTER TYPE "EpicRequestKind" ADD VALUE 'DEACTIVATE';
