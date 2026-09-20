import { Card } from "@/platform/ui/card";
import { SectionHeader } from "@/platform/ui/section-header";
import { Alert } from "@/platform/ui/alert";
import { EmptyState } from "@/platform/ui/empty-state";
import { Badge } from "@/platform/ui/badge";
import { Button } from "@/platform/ui/button";
import { ConfirmButton } from "@/platform/ui/confirm-button";
import { Field, Input, Textarea } from "@/platform/ui/input";
import { Select } from "@/platform/ui/select";
import { FormActions } from "@/platform/ui/form";
import { SaveForm } from "@/platform/ui/save-form";
import { SubmitButton } from "@/platform/ui/submit-button";
import { formatTimestamp, sectionLength } from "@/modules/learning/engine/watch";
import {
  getVideoCourseForEdit,
  listMakeupCycleOptions,
} from "@/modules/learning/services/video-courses";
import { VideoUploadForm, CaptionsUploadForm } from "./VideoUploadForm";
import {
  clearCaptionsAction,
  createSectionAction,
  deleteQuestionAction,
  deleteSectionAction,
  deleteVideoAction,
  moveSectionAction,
  saveQuestionAction,
  setMakeupCycleAction,
  updateSectionAction,
} from "./video-actions";

const OPTIONS_HINT = "One answer choice per line. Put * in front of the right one.";

function optionLines(options: unknown, correctValue: string | null): string {
  if (!Array.isArray(options)) return "";
  return options
    .map((o) => {
      const opt = o as { value?: unknown; label?: unknown };
      const label = typeof opt.label === "string" ? opt.label : "";
      return opt.value === correctValue ? `*${label}` : label;
    })
    .join("\n");
}

function bytesLabel(size: bigint | null): string {
  if (size == null) return "";
  const mb = Number(size) / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

/**
 * The authoring surface for a VIDEO course: its uploaded recordings, the
 * sections cut from them, each section's quiz, and the training cycle this
 * course makes up. Sections and questions are plain server-action forms; only
 * the uploads need a client component, for the progress bar.
 */
export async function VideoCourseEditor({ courseId }: { courseId: string }) {
  const course = await getVideoCourseForEdit(courseId);
  if (!course) return null;
  const cycles = await listMakeupCycleOptions();
  const videos = course.videos;

  return (
    <>
      <Card className="space-y-4">
        <SectionHeader level="title">Videos</SectionHeader>
        {videos.length === 0 ? (
          <EmptyState inline>No video uploaded yet.</EmptyState>
        ) : (
          <ul className="space-y-4">
            {videos.map((v) => (
              <li key={v.id} className="rounded-xl border border-border p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-foreground">{v.fileName}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {v.durationSeconds != null ? formatTimestamp(v.durationSeconds) : "Length unknown"}
                      {bytesLabel(v.sizeBytes) ? ` · ${bytesLabel(v.sizeBytes)}` : ""}
                      {v.captionsFileName ? ` · captions: ${v.captionsFileName}` : " · no captions"}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {v.captionsKey && (
                      <form action={clearCaptionsAction}>
                        <input type="hidden" name="courseId" value={courseId} />
                        <input type="hidden" name="videoId" value={v.id} />
                        <ConfirmButton label="Remove captions" confirmLabel="Remove captions?" size="sm" />
                      </form>
                    )}
                    <form action={deleteVideoAction}>
                      <input type="hidden" name="courseId" value={courseId} />
                      <input type="hidden" name="videoId" value={v.id} />
                      <ConfirmButton label="Delete video" confirmLabel="Delete this video?" size="sm" />
                    </form>
                  </div>
                </div>
                {v.durationSeconds == null && (
                  <Alert tone="warning" className="mt-3">
                    This browser could not read the video&apos;s length, so every section using it needs an
                    explicit end time.
                  </Alert>
                )}
                <CaptionsUploadForm courseId={courseId} videoId={v.id} />
              </li>
            ))}
          </ul>
        )}
        <VideoUploadForm courseId={courseId} />
      </Card>

      <Card className="space-y-4">
        <SectionHeader level="title">Sections</SectionHeader>
        <p className="text-sm text-muted-foreground">
          Each section is a stretch of a video followed by a quiz. Members watch them in order, cannot skip
          ahead, and the next section opens only once the quiz before it is passed.
        </p>

        {course.sections.length === 0 ? (
          <EmptyState inline>No sections yet.</EmptyState>
        ) : (
          <ul className="space-y-6">
            {course.sections.map((section, i) => {
              const video = videos.find((v) => v.id === section.videoId) ?? null;
              const length = video ? sectionLength(section, video.durationSeconds) : null;
              return (
                <li key={section.id} className="rounded-xl border border-border p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <Badge tone="default">Section {i + 1}</Badge>
                      {length == null ? (
                        <Badge tone="warning">Not ready</Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">{formatTimestamp(length)} to watch</span>
                      )}
                    </div>
                    <div className="flex items-center gap-1">
                      <form action={moveSectionAction}>
                        <input type="hidden" name="courseId" value={courseId} />
                        <input type="hidden" name="sectionId" value={section.id} />
                        <input type="hidden" name="direction" value="up" />
                        <Button type="submit" variant="ghost" size="sm" disabled={i === 0}>
                          Move up
                        </Button>
                      </form>
                      <form action={moveSectionAction}>
                        <input type="hidden" name="courseId" value={courseId} />
                        <input type="hidden" name="sectionId" value={section.id} />
                        <input type="hidden" name="direction" value="down" />
                        <Button type="submit" variant="ghost" size="sm" disabled={i === course.sections.length - 1}>
                          Move down
                        </Button>
                      </form>
                      <form action={deleteSectionAction}>
                        <input type="hidden" name="courseId" value={courseId} />
                        <input type="hidden" name="sectionId" value={section.id} />
                        <ConfirmButton label="Delete" confirmLabel="Delete this section?" size="sm" />
                      </form>
                    </div>
                  </div>

                  <SaveForm action={updateSectionAction} className="mt-4 space-y-4">
                    <input type="hidden" name="courseId" value={courseId} />
                    <input type="hidden" name="sectionId" value={section.id} />
                    <Field label="Title">
                      <Input name="title" defaultValue={section.title} required />
                    </Field>
                    <Field label="Video">
                      <Select name="videoId" defaultValue={section.videoId ?? ""} className="max-w-md">
                        <option value="">No video</option>
                        {videos.map((v) => (
                          <option key={v.id} value={v.id}>
                            {v.fileName}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <Field label="Start time" hint="90, 1:30, or 1:02:03">
                        <Input name="startSeconds" defaultValue={formatTimestamp(section.startSeconds)} />
                      </Field>
                      <Field label="End time" hint="Leave blank to run to the end of the video">
                        <Input
                          name="endSeconds"
                          defaultValue={section.endSeconds != null ? formatTimestamp(section.endSeconds) : ""}
                        />
                      </Field>
                      <Field label="Pass percent">
                        <Input name="passPercent" type="number" min={1} max={100} defaultValue={section.passPercent} />
                      </Field>
                      <Field label="Attempts before locking" hint="Makeup courses only. A director resets a lock from the training roster.">
                        <Input name="maxAttempts" type="number" min={1} max={20} defaultValue={section.maxAttempts} />
                      </Field>
                    </div>
                    <FormActions>
                      <SubmitButton>Save section</SubmitButton>
                    </FormActions>
                  </SaveForm>

                  <div className="mt-6 border-t border-border pt-4">
                    <SectionHeader level="card">Quiz</SectionHeader>
                    {section.questions.length === 0 ? (
                      <Alert tone="warning" className="mt-2">
                        A section with no keyed question can never be passed, so the course stays hidden from
                        members until you add one.
                      </Alert>
                    ) : (
                      <ul className="mt-3 space-y-4">
                        {section.questions.map((q) => (
                          <li key={q.id} className="rounded-lg border border-border p-3">
                            <SaveForm action={saveQuestionAction} className="space-y-3">
                              <input type="hidden" name="courseId" value={courseId} />
                              <input type="hidden" name="questionId" value={q.id} />
                              <Field label="Question">
                                <Input name="prompt" defaultValue={q.prompt} required />
                              </Field>
                              <Field label="Answer choices" hint={OPTIONS_HINT}>
                                <Textarea
                                  name="options"
                                  defaultValue={optionLines(q.options, q.correctValue)}
                                  className="min-h-[96px] font-mono text-xs"
                                />
                              </Field>
                              <FormActions>
                                <SubmitButton>Save question</SubmitButton>
                              </FormActions>
                            </SaveForm>
                            <form action={deleteQuestionAction} className="mt-2">
                              <input type="hidden" name="courseId" value={courseId} />
                              <input type="hidden" name="questionId" value={q.id} />
                              <ConfirmButton label="Delete question" confirmLabel="Delete this question?" size="sm" />
                            </form>
                          </li>
                        ))}
                      </ul>
                    )}

                    <SaveForm action={saveQuestionAction} className="mt-4 space-y-3 rounded-lg border border-dashed border-border p-3">
                      <input type="hidden" name="courseId" value={courseId} />
                      <input type="hidden" name="sectionId" value={section.id} />
                      <Field label="New question">
                        <Input name="prompt" placeholder="What does HIPAA protect?" required />
                      </Field>
                      <Field label="Answer choices" hint={OPTIONS_HINT}>
                        <Textarea
                          name="options"
                          placeholder={"*Protected health information\nPublic health notices"}
                          className="min-h-[96px] font-mono text-xs"
                          required
                        />
                      </Field>
                      <FormActions>
                        <SubmitButton>Add question</SubmitButton>
                      </FormActions>
                    </SaveForm>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        <SaveForm action={createSectionAction} className="flex gap-2 border-t border-border pt-4" savedLabel="Added">
          <input type="hidden" name="courseId" value={courseId} />
          <Input name="title" placeholder="New section title" required className="flex-1" />
          <SubmitButton pendingLabel="Adding…">Add section</SubmitButton>
        </SaveForm>
      </Card>

      <Card className="space-y-4">
        <SectionHeader level="title">Training makeup</SectionHeader>
        <p className="text-sm text-muted-foreground">
          Link this course to a training cycle and it becomes that cycle&apos;s online makeup: it is shown only
          to members whose morning session is outstanding, from their training step, and finishing it completes
          their morning. A linked course is never assigned by department and never counts toward the learning
          step.
        </p>
        <SaveForm action={setMakeupCycleAction}>
          <input type="hidden" name="courseId" value={courseId} />
          <Field label="Makes up">
            <Select name="cycleId" defaultValue={course.makeupForCycleId ?? ""} className="max-w-md">
              <option value="">Not a makeup course</option>
              {cycles.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.termName}: {c.title}
                </option>
              ))}
            </Select>
          </Field>
          <FormActions>
            <SubmitButton>Save makeup link</SubmitButton>
          </FormActions>
        </SaveForm>
      </Card>
    </>
  );
}
