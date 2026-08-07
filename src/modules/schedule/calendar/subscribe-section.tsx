/**
 * The calendar-subscribe card plus its data loading, so every page that offers
 * the feed shows exactly the same thing.
 *
 * The card is rendered on both My Info and My Schedule. Keeping the load here
 * rather than in each page means the two surfaces cannot drift apart, which
 * matters most for the refresh-lag disclosure: a member who only ever sees one
 * of the two pages still gets told that Google updates on its own timing.
 *
 * Authorization deliberately stays in the pages. The two pages gate on
 * different module permissions, so each supplies its own already-authorized
 * actions rather than this component assuming one of them.
 */

import { getSetting } from "@/platform/settings/service";
import { getDisplayTimeZone } from "@/platform/dates/resolve";
import { readFeedToken } from "./feed-token";
import { CalendarSubscribeCard } from "./subscribe-card";

type Props = {
  personId: string;
  generateAction: () => Promise<void>;
  resetAction: () => Promise<void>;
};

export async function CalendarSubscribeSection({ personId, generateAction, resetAction }: Props) {
  const [feedToken, baseUrl, timeZone] = await Promise.all([
    readFeedToken(personId),
    getSetting<string>("app.baseUrl"),
    getDisplayTimeZone(),
  ]);

  return (
    <CalendarSubscribeCard
      // The .ics suffix is what makes clients sniff the type correctly; the
      // route accepts the bare form too.
      feedUrl={feedToken ? `${baseUrl}/api/calendar/${feedToken.token}.ics` : null}
      lastFetchedAt={feedToken?.lastFetchedAt ?? null}
      timeZone={timeZone}
      generateAction={generateAction}
      resetAction={resetAction}
    />
  );
}
