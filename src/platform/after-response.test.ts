import { beforeEach, describe, expect, it, vi } from "vitest";

const { afterMock } = vi.hoisted(() => ({ afterMock: vi.fn() }));
vi.mock("next/server", () => ({ after: afterMock }));

import { runAfterResponse } from "./after-response";

describe("runAfterResponse", () => {
  beforeEach(() => {
    afterMock.mockReset();
  });

  it("hands the task to after() inside a request scope, without running it now", () => {
    const task = vi.fn(async () => {});

    runAfterResponse(task);

    expect(afterMock).toHaveBeenCalledWith(task);
    expect(task).not.toHaveBeenCalled();
  });

  it("runs the task immediately when after() throws outside a request scope", () => {
    afterMock.mockImplementation(() => {
      throw new Error("`after` was called outside a request scope");
    });
    const task = vi.fn(async () => {});

    runAfterResponse(task);

    expect(task).toHaveBeenCalledOnce();
  });
});
