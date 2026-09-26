# HAVEN Hub mobile app

The iOS and Android app for the HAVEN Hub, built with [Expo](https://docs.expo.dev) (SDK 57) and Expo Router.
It is a separate project from the Next.js website at the repository root: its own `package.json`,
`node_modules`, lint and typecheck. The website's tooling ignores this folder.

## What it does today

| Tab | Native in the app | Backed by |
| --- | --- | --- |
| Home | Greeting, active term, unread count, next shift, your teams | `GET /api/mobile/v1/me`, `/schedule` |
| Schedule | Your shifts by term, attendings, closed-clinic notices, past shifts | `GET /api/mobile/v1/schedule` |
| Notifications | Inbox with unread dots, badge, mark one / all read, open links | `GET /api/mobile/v1/notifications`, `POST .../read` |
| More | Every other Hub module you can access, opened on the website in an in-app browser; sign out | `GET /api/mobile/v1/me` (`modules`) |

The More tab is how the app covers the whole Hub from day one: it lists exactly the modules the
website's nav would show the signed-in person. Screens move from "opens on the website" to native
one at a time; see [Adding a screen](#adding-a-screen).

## How sign-in works

The app uses the Hub's existing OAuth 2.1 server, the same one the Claude connector uses
(`src/platform/oauth` in the website). No new login system and no secrets in the app:

1. The app registers itself as a public client at `/api/oauth/register` with its redirect URI
   (`org.havenfreeclinic.hub://oauth` in a build).
2. It opens `/oauth/authorize` in the system browser with PKCE and `resource=<hub>/api/mobile`.
   The person signs in with Yale SSO exactly as on the website, then approves the app on the
   consent screen.
3. The code comes back to the app, which exchanges it at `/api/oauth/token` for a one-hour
   access token and a rotating 30-day refresh token, stored in the iOS Keychain / Android Keystore.
4. Every API call sends the access token. Tokens are bound to the `/api/mobile` resource, so a
   token issued to the recruitment connector can't be used here and vice versa.

The API (`src/app/api/mobile/v1`) runs the same module and permission checks as the matching Hub
page, so the app never shows more than the website would. People can see and disconnect the app
under **My Info → Connected apps**; offboarding someone stops their app on the next request.

## Before the first production release

- **Vercel Firewall bypass for `/api/mobile/*`.** Production answers non-browser requests with
  Vercel's Attack Challenge Mode, which an app can't solve. Add a bypass rule for the path
  (Project → Firewall → Configure). See `docs/DEPLOY.md` §4. Without it, sign-in works but every
  screen says "The Hub sent an unexpected response".
- **App icon and splash.** `assets/` still holds Expo's placeholder icon images.
- **Store accounts.** An Apple Developer Program membership and a Google Play Console account,
  under the clinic's name.

## Running it

```sh
cd mobile
npm install
npm start          # then press i (iOS simulator), a (Android emulator), or scan the QR code with Expo Go
```

By default the app talks to production (`extra.hubUrl` in `app.json`). To point it elsewhere:

```sh
EXPO_PUBLIC_HUB_URL=https://staging.havenfreeclinic.org npm start
EXPO_PUBLIC_HUB_URL=http://192.168.1.20:3000 npm start   # your computer's LAN IP running `npm run dev`
```

Against a local `npm run dev`, sign in with the dev login (e.g. `dev.volunteer@yale.edu` from the
seed data). `npm run web` runs the app in a browser for quick UI work; the web build keeps the session
in `sessionStorage` rather than the Keychain, and the browser enforces CORS, which the API doesn't
send. It is a dev preview only and isn't shipped.

## Checks

```sh
npm run typecheck
npm run lint
npx expo-doctor
```

## Building and releasing

Builds use [EAS](https://docs.expo.dev/eas/): no Xcode or Android Studio needed.

```sh
npx eas-cli@latest login
npx eas-cli@latest build:configure          # once: creates eas.json and links the project
npx eas-cli@latest build --platform all --profile preview      # installable test builds
npx eas-cli@latest build --platform all --profile production
npx eas-cli@latest submit --platform all                         # upload to TestFlight / Play Console
```

The bundle identifier and Android package are both `org.havenfreeclinic.hub` (`app.json`). Change
them before the first store upload if the clinic prefers another; they can't change afterwards.

## Adding a screen

1. **API**: add a route under `src/app/api/mobile/v1/` in the website, wrapped in `mobileHandler`
   (`src/platform/mobile/api.ts`). Call the existing module service, apply the same gate the Hub
   page uses (`mayUseModule`, or the page's own permission check), and return plain JSON: dates
   as `YYYY-MM-DD` keys or ISO strings, links as absolute URLs. Add a case to
   `src/app/api/mobile/v1/mobile-api.test.ts`.
2. **App**: add the response type to `src/lib/api.ts` and a screen under `src/app/`. `useApi(path)`
   handles loading, errors, pull-to-refresh and reloading when the tab regains focus.

Layout: `src/app` holds routes only (Expo Router); `src/components` shared UI; `src/lib` auth,
API client, theme and helpers.
