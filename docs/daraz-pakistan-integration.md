# Daraz Pakistan POS Integration

This POS talks to **Daraz Pakistan only**. Other Daraz country gateways (BD, LK, NP, MM, etc.) are out of scope.

## Official docs (keep these handy)

| Topic                               | Link                                                                                   |
| ----------------------------------- | -------------------------------------------------------------------------------------- |
| Pakistan REST gateway               | https://api.daraz.pk/rest                                                              |
| Refresh access token                | https://open.daraz.com/doc/api.htm#/api?cid=3&path=/auth/token/refresh&methodType=POST |
| Generate access token               | https://open.daraz.com/doc/api.htm#/api?cid=3&path=/auth/token/create&methodType=POST  |
| Seller authorization (code → token) | https://open.daraz.com/apps/doc/doc?nodeId=29626&docId=120222                          |
| Request signing (HMAC-SHA256)       | https://open.daraz.com/apps/doc/doc?nodeId=29627&docId=120322                          |
| Open Platform API index             | https://open.daraz.com/doc/api.htm                                                     |

Seller authorize URL for Pakistan:

```
https://api.daraz.pk/oauth/authorize?response_type=code&force_auth=true&redirect_uri={CALLBACK}&client_id={APP_KEY}
```

REST calls always go to `https://api.daraz.pk/rest` (this codebase hard-codes that host).

## Scope of this phase

Implemented now:

1. Generate access token from seller authorization `code` + app key/secret.
2. Refresh access token from stored (or override) `refresh_token` + app key/secret.
3. Cron to refresh every Daraz integration that already has a `refresh_token`.

Not implemented yet (future docs in this same series): products, orders, stock.

## Integration record (`store_type = daraz`)

Create an integration with `store_type: "daraz"`. Map Daraz credentials onto the existing fields:

| Integration field      | Daraz value                                                                            |
| ---------------------- | -------------------------------------------------------------------------------------- |
| `store_type`           | `daraz`                                                                                |
| `url`                  | `https://api.daraz.pk/rest`                                                            |
| `key`                  | App Key (`app_key` / `client_id`)                                                      |
| `secret`               | App Secret (`app_secret`)                                                              |
| `token`                | First-time: leave empty (Generate Token opens Daraz). After generate: access token |
| `token_expiry`         | Access token expiry                                                                    |
| `refresh_token`        | Refresh token (must be saved; each refresh returns a **new** one)                      |
| `refresh_token_expiry` | Always **24 hours** from generate/refresh (POS policy, not Daraz `refresh_expires_in`) |

Key and secret never go in the URL as the only auth — every Daraz REST call is signed with HMAC-SHA256 using the App Secret.

## Token flow

```
POS Generate Token → GET /api/integration/daraz/authorize-url/:id
        ↓
Seller signs in at https://api.daraz.pk/oauth/authorize
        ↓
Daraz redirects to the app Callback URL:
https://testv3.websitedemolynk.com/pos_webhook/webhook.php?callback=daraz&code=4_506036_…
        ↓
Webhook emails the query string (to faraz.rawala@gmail.com)
        ↓
Paste that full callback URL, the JSON, or code=4_… into Generate Token
        ↓
POST /api/integration/daraz/generate-token/:id
        ↓
Daraz POST /auth/token/create  → access_token + refresh_token
        ↓
Saved on integration.token / integration.refresh_token
        ↓
Later: POST /api/integration/daraz/refresh-token/:id
        ↓
Daraz POST /auth/token/refresh  → new access_token + new refresh_token
```

The Callback URL on the Daraz Open Platform app **must match** `redirect_uri` exactly (no `code=`):

`https://testv3.websitedemolynk.com/pos_webhook/webhook.php?callback=daraz`

After seller login, Daraz appends the authorization code, for example:

`https://testv3.websitedemolynk.com/pos_webhook/webhook.php?callback=daraz&code=4_506036_…`

Live Pakistan codes look like `4_{app_key}_…`. Older docs examples use `0_…`. Both work.

Do **not** paste `webhook.php?hello=test` or the Callback URL with no `code=`. Those are the webhook itself, not a seller `code`.

Notes:

- POS stores `refresh_token_expiry` as **24 hours** from generate/refresh. Refresh before that window, even if Daraz returns a longer `refresh_expires_in`.
- If Daraz returns `refresh_expires_in` = `0`, refresh is not allowed; the seller must authorize again.
- After the refresh token expires, the seller must re-authorize.

## POS APIs

Base path: `/api`. These routes are public (same pattern as Shopify generate-token) so they can be used from cron.

### 1. Authorize URL (Pakistan seller login)

```http
GET /api/integration/daraz/authorize-url/:id
GET /api/integration/daraz/authorize-url?integration_id=...
```

Builds `https://api.daraz.pk/oauth/authorize?response_type=code&force_auth=true&redirect_uri={CALLBACK}&client_id={APP_KEY}&state={integration_id}`.

Default `redirect_uri` is the registered webhook:

`https://testv3.websitedemolynk.com/pos_webhook/webhook.php?callback=daraz`

Override with env `DARAZ_PK_REDIRECT_URI` or query `redirect_uri` — it must still match the Daraz app Callback URL.

POS **Generate Token** opens this URL, then asks you to paste `code=4_...` (or `code=0_...`) from the webhook email.

Optional Node receiver if you later point the Daraz Callback URL at this API:

```http
GET  /api/integration/daraz/callback?code=4_...&state=<integration_id>
POST /api/integration/daraz/callback
```

### 2. Generate token (authorization code)

```http
POST /api/integration/daraz/generate-token/:id
GET  /api/integration/daraz/generate-token/:id
POST /api/integration/daraz/generate-token
GET  /api/integration/daraz/generate-token?integration_id=...
```

Body / query (optional — first-time generate reads Token):

| Field                   | Required | Description                               |
| ----------------------- | -------- | ----------------------------------------- |
| Token field             | No*      | Optional. Usually filled from the Generate Token prompt (`code=4_…`) |
| `code`                  | No       | Same seller code if not stored on Token   |
| `key` / `app_key`       | No       | Override and persist App Key              |
| `secret` / `app_secret` | No       | Override and persist App Secret           |
| `uuid`                  | No       | Optional Daraz uuid from authorize URL    |
| `company_id`            | No       | Tenant filter                             |

\*If Token is empty and `code` is not passed, the API returns: `Click Generate Token, authorize on Daraz Pakistan, then paste the seller code...`

The POS store form uses Key / Secret / Token. First time: save App Key + Secret, then **Generate Token** (opens Daraz PK login). After authorize, paste `code=4_…` from the webhook email (or the full redirect URL). Later **Refresh Token** uses the stored `refresh_token`.

Example after saving `token: "4_506036_….` on the integration:

```http
POST /api/integration/daraz/generate-token/6520abe1234567890fedcba0
```

### 3. Refresh token

```http
POST /api/integration/daraz/refresh-token/:id
GET  /api/integration/daraz/refresh-token/:id
POST /api/integration/daraz/refresh-token
GET  /api/integration/daraz/refresh-token?integration_id=...
```

Uses `integration.key` + `integration.secret`. POS **Refresh token** uses this same endpoint.

Lookup order:

1. Request `code` → generate (`/auth/token/create`)
2. Request/`refresh_token` field → refresh (`/auth/token/refresh`)
3. Else `token` field: if it looks like an auth code (`4_…` / `0_…`) generate, otherwise use it as `refresh_token`

The POS store form uses Key / Secret / Token. First time: save App Key + Secret, then **Generate Token** (opens Daraz PK login). After authorize, paste `code=4_…` from the webhook email. Later **Refresh Token** uses the stored `refresh_token`.

| Field                   | Required | Description                                                 |
| ----------------------- | -------- | ----------------------------------------------------------- |
| `refresh_token`         | No       | Override for this call; latest value is saved after success |
| `code`                  | No       | First-time seller authorization code                        |
| `token`                 | No       | Used as refresh_token or auth code when refresh_token empty |
| `key` / `app_key`       | No       | Override and persist App Key                                |
| `secret` / `app_secret` | No       | Override and persist App Secret                             |

Example:

```http
POST /api/integration/daraz/refresh-token/6520abe1234567890fedcba0
```

### 4. Refresh all Daraz tokens (cron)

```http
GET  /api/integration/daraz/refresh-tokens-cron
POST /api/integration/daraz/refresh-tokens-cron
```

Optional: `company_id`, `status` (`active` default, `all` to include inactive).

Skipped when `key`/`secret` is missing, and when there is no `refresh_token` / reusable `token`.

## Success shape (generate / refresh)

Tokens are masked in the HTTP response. Full values are stored on the integration.

```json
{
  "success": true,
  "message": "Daraz Pakistan access token refreshed and saved on integration.token. Latest refresh_token was also saved.",
  "data": {
    "integration_id": "6520abe1234567890fedcba0",
    "country": "pk",
    "gateway": "https://api.daraz.pk/rest",
    "access_token_masked": "500006…3GBg",
    "refresh_token_masked": "500016…Woi",
    "expires_in": 15552000,
    "refresh_expires_in": 86400,
    "token_expiry": "2026-10-21T00:00:00.000Z",
    "refresh_token_expiry": "2026-09-22T00:00:00.000Z",
    "account": "seller@example.com",
    "grant_type": "refresh_token"
  }
}
```

## Signing (for future Daraz business APIs)

Every call to `https://api.daraz.pk/rest{path}` must include:

- `app_key`
- `timestamp` (milliseconds)
- `sign_method=sha256`
- `sign`
- `access_token` (not used on `/auth/token/create` or `/auth/token/refresh`)

Signature steps (implemented in `utils/darazTokenRefresh.js`):

1. Collect system + API params except `sign`.
2. Sort parameter names by ASCII.
3. Concatenate `name + value` with no separators.
4. Prepend the API path, e.g. `/auth/token/refresh`.
5. HMAC-SHA256 with App Secret; output uppercase hex.

## Code map

| File                         | Role                                    |
| ---------------------------- | --------------------------------------- |
| `utils/darazTokenRefresh.js` | PK gateway, HMAC sign, create + refresh |
| `controllers/integration.js` | Generate / refresh / cron handlers      |
| `routes/api.js`              | HTTP routes                             |
| `models/integration.js`      | `refresh_token`, `refresh_token_expiry` |
