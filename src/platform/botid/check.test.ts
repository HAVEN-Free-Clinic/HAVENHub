import { expect, it, vi } from "vitest";

vi.mock("botid/server", () => ({ checkBotId: vi.fn() }));

import { checkBotId } from "botid/server";
import { isBotRequest } from "./check";

it("reports what BotID classified", async () => {
  vi.mocked(checkBotId).mockResolvedValueOnce({ isBot: true } as Awaited<ReturnType<typeof checkBotId>>);
  expect(await isBotRequest()).toBe(true);
  vi.mocked(checkBotId).mockResolvedValueOnce({ isBot: false } as Awaited<ReturnType<typeof checkBotId>>);
  expect(await isBotRequest()).toBe(false);
});

it("treats a failed check as human so a sign-in link is never withheld by an outage", async () => {
  vi.mocked(checkBotId).mockRejectedValueOnce(new Error("verification unreachable"));
  expect(await isBotRequest()).toBe(false);
});
