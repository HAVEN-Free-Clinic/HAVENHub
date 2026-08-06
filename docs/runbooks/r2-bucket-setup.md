# R2 bucket setup

One bucket per environment: `havenhub-uploads` for production, and
`havenhub-uploads-preview` for preview deployments. Keeping preview separate
means a preview branch can never write into or delete production files.

> **Status: steps 1 and 3 are already done.** Both buckets exist and both CORS
> policies are applied, in Cloudflare account
> `9395fb1f78ce8bbe601b9f0ef0a08c15` (`Jcarne12@genesee.edu's Account`),
> location ENAM, storage class Standard. Step 2 (the API token) and step 4 (the
> Vercel environment variables) still have to be done by hand: the token
> endpoints are not reachable with a delegated OAuth session, and R2's temporary
> credentials need an existing permanent key to sign with, so there is no
> bootstrap path.
>
> **Confirm the account is the right one before any data moves into it.** These
> buckets will hold HIPAA training certificates and signed onboarding contracts.
> If they belong in an institutional account rather than a personal one, delete
> both buckets and redo this setup there. Nothing is stored yet, so that is free
> right now and expensive after the backfill.

## 1. Create the buckets

Cloudflare dashboard, R2 > Create bucket. Standard storage class. No public
access: every read in the application is proxied through an authenticated route
handler, and a public bucket would expose HIPAA certificates.

## 2. Create an API token

R2 > Manage API tokens > Create token, with **Object Read & Write** permission
scoped to the two buckets. Record the Access Key ID and Secret Access Key; the
secret is shown once.

## 3. CORS rule

Required, and its absence is the single most confusing failure in this setup:
without it the browser SCORM upload fails with an opaque CORS error that looks
nothing like a configuration problem.

Bucket > Settings > CORS policy. The two buckets get **different** origin lists,
because a production bucket has no reason to accept a PUT from a laptop.

`havenhub-uploads` (production):

```json
[
  {
    "AllowedOrigins": [
      "https://hub.havenfreeclinic.org",
      "https://apply.havenfreeclinic.org"
    ],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["Content-Type"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

`havenhub-uploads-preview`:

```json
[
  {
    "AllowedOrigins": [
      "https://staging.havenfreeclinic.org",
      "http://localhost:3000",
      "https://*.vercel.app"
    ],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["Content-Type"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

`AllowedHeaders` must include `Content-Type` because the browser sends that
header on every upload PUT and CORS requires any non-simple header the browser
sends to be explicitly allowed -- independent of whether the SDK signature
covers it (it does not; only `host` is signed, see `r2.ts`'s `presignPut`).
Omitting it here fails the upload with an opaque CORS error rather than
anything that names the real cause.

The `https://*.vercel.app` wildcard is verified, not just accepted: a real
preflight request from `https://havenhub-abc123.vercel.app` returned that exact
origin back in `access-control-allow-origin`, confirming R2 matches the
wildcard at request time, not only that it stored the rule correctly. No
per-deploy origin list is needed; the wildcard covers every preview URL Vercel
mints.

## 4. Environment variables

Set on the Vercel project, production and preview scoped separately so preview
points at the preview bucket:

| Variable | Value |
| --- | --- |
| `R2_ACCOUNT_ID` | `9395fb1f78ce8bbe601b9f0ef0a08c15` |
| `R2_ACCESS_KEY_ID` | from step 2 |
| `R2_SECRET_ACCESS_KEY` | from step 2 |
| `R2_BUCKET` | `havenhub-uploads` or `havenhub-uploads-preview` |

Leave `BLOB_READ_WRITE_TOKEN` set on production for the duration of the cutover.
It is what makes the rollback work and what lets reads fall through to the old
store; see `r2-cutover.md`. On preview scope, leave it unset or point it at the
staging Blob store, because deletes fan out to both stores while both are
configured.

All four are required together. A partial configuration is rejected at boot
rather than silently falling back to the ephemeral local disk.
