# R2 bucket setup

One bucket per environment: `havenhub-uploads` for production, and
`havenhub-uploads-preview` for preview deployments. Keeping preview separate
means a preview branch can never write into or delete production files.

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

Bucket > Settings > CORS policy, on **both** buckets:

```json
[
  {
    "AllowedOrigins": [
      "https://hub.havenfreeclinic.org",
      "https://apply.havenfreeclinic.org",
      "http://localhost:3000"
    ],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["content-type"],
    "MaxAgeSeconds": 3600
  }
]
```

Add any preview domain you upload from. `AllowedHeaders` must include
`content-type`, because the presigned PUT signs that header and the browser
sends it.

## 4. Environment variables

Set on the Vercel project, production and preview scoped separately so preview
points at the preview bucket:

| Variable | Value |
| --- | --- |
| `R2_ACCOUNT_ID` | Cloudflare account ID (R2 overview page) |
| `R2_ACCESS_KEY_ID` | from step 2 |
| `R2_SECRET_ACCESS_KEY` | from step 2 |
| `R2_BUCKET` | `havenhub-uploads` or `havenhub-uploads-preview` |

All four are required together. A partial configuration is rejected at boot
rather than silently falling back to the ephemeral local disk.
