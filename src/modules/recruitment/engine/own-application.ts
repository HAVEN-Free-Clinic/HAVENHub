// The matcher lives in platform (src/platform/recruitment/own-application.ts) so
// platform code, which may not import modules, can apply the review lock too.
export {
  isOwnApplication,
  applicationOwnerAmong,
  type ReviewerIdentity,
  type ApplicantIdentity,
} from "@/platform/recruitment/own-application";
