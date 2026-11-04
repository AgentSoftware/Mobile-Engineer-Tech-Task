# Doorstep API

A small mock of the Doorstep agent API. It follows the [JSON:API](https://jsonapi.org/format/) conventions.

```bash
npm install
npm start          # http://localhost:3000, and your machine's network address
npm test
```

All data lives in memory. Restarting the server resets every change you made and signs everyone out.

## Configuration

| Variable | Default | Effect |
|---|---|---|
| `PORT` | `3000` | Port to listen on (all interfaces) |
| `LATENCY_MIN_MS` / `LATENCY_MAX_MS` | `200` / `900` | Each API response is delayed by a random time in this range |
| `FAILURE_RATE` | `0` | Share of API requests (0 to 1) that fail with a `503` |
| `LOG_REQUESTS` | on | Set to `0` to stop logging each request |

## Conventions

- Responses use `Content-Type: application/vnd.api+json`. Requests can send `application/vnd.api+json` or `application/json`.
- Every endpoint except `POST /auth/token`, `GET /` and `/images/*` needs `Authorization: Bearer <accessToken>`.
- Related resources are always returned in `included`, so a response has everything needed to show its `data`.
- Ids are strings.
- Date-times are ISO 8601 instants in UTC, e.g. `2026-11-04T09:30:00.000Z`. When you send one, include an offset (`Z` or `+01:00`).
- Dates in filters are `YYYY-MM-DD` and refer to the UK calendar day (Europe/London).
- Viewing data in `data/*.json` is written around January 2030. At startup it is moved, whole weeks at a time, so that it falls in the current week.

### Errors

Errors come back as an `errors` array. Every error has a `status`, a machine-readable `code` and a `title`. Some also have a `detail`, a `source` and a `meta` object.

```json
{
  "errors": [
    {
      "status": "422",
      "code": "invalid_field",
      "title": "Choose an interest level",
      "source": { "pointer": "/data/attributes/interestLevel" }
    }
  ]
}
```

| Status | When |
|---|---|
| `400` | Malformed body or query parameter (`source.parameter` names it) |
| `401` | Missing, invalid or expired token; wrong credentials |
| `404` | Unknown resource or route |
| `409` | Conflict: a time clash, a duplicate, or a `type`/`id` that does not match |
| `422` | Validation failed. There is one error per problem, and `source.pointer` names the field |
| `503` | Simulated outage (see `FAILURE_RATE`) |

### Pagination

Collections marked *paginated* accept `page[number]` (from 1) and `page[size]` (default 20; larger values are treated as 50). They return `links.first`, `links.prev`, `links.next` and `links.last`, plus `meta.total`. `links.prev` and `links.next` are `null` at the ends.

## Endpoints

### `POST /auth/token`

Body (plain JSON): `{ "email": "alex.morgan@example.com", "password": "doorstep" }`. Every seeded agent uses the password `doorstep`.

`201`: a `tokens` resource with `accessToken`, `tokenType` and `expiresAt` (12 hours), related to the signed-in `agents` resource. `401 invalid_credentials` when the email or password is wrong.

### `GET /me`

The signed-in agent.

### `GET /agents`

Everyone in the branch.

### `GET /lookups`

Reference lists. Filter with `filter[category]`:

| Category | Used for |
|---|---|
| `cancellation-reason` | `cancellationReason` when cancelling a viewing |
| `interest-level` | `interestLevel` on feedback |
| `feedback-quick-response` | `quickResponses` on feedback |
| `viewing-duration` | `durationMinutes` on a viewing (`value` is in minutes) |

### `GET /viewings`

The signed-in agent's viewings, earliest first. Accepts one of:

- `filter[date]=YYYY-MM-DD`. Defaults to today.
- `filter[from]=YYYY-MM-DD&filter[to]=YYYY-MM-DD`, both required, both inclusive.

Viewings are shared across the branch. Any signed-in agent can fetch or change any viewing by id.

### `GET /viewings/:id`

### `POST /viewings`

Books a viewing for the signed-in agent. Other agents can be added to it.

```json
{
  "data": {
    "type": "viewings",
    "attributes": { "startsAt": "2026-11-09T10:00:00Z", "durationMinutes": 30, "notes": "Optional, max 1000 characters" },
    "relationships": {
      "property": { "data": { "type": "properties", "id": "12" } },
      "applicant": { "data": { "type": "people", "id": "40" } },
      "agents": { "data": [{ "type": "agents", "id": "2" }] }
    }
  }
}
```

- `durationMinutes` defaults to 30.
- New viewings start as `unconfirmed`.
- `422` when a field is invalid or `startsAt` is not in the future.
- `409` when the slot overlaps another live viewing:
  - `property_unavailable`
  - `applicant_unavailable`
  - `agent_unavailable`
  - The error's `detail` says when the clashing viewing is booked, and `meta.viewingId` gives its id.

### `PATCH /viewings/:id`

Send only the attributes that change.

- Confirm: `{ "status": "confirmed" }`.
- Cancel: `{ "status": "cancelled", "cancellationReason": "<lookup id>" }`. A cancelled viewing cannot be changed again (`422 viewing_cancelled`).
- Reschedule: `{ "startsAt": "..." }` and/or `{ "durationMinutes": 45 }`. The viewing goes back to `unconfirmed`. The same `409` clash rules apply as for booking.
- Notes: `{ "notes": "..." }` (max 1000 characters; `null` clears them).

`data.id` must match the URL, or the request fails with `409 id_mismatch`.

### `POST /viewings/:id/feedback`

```json
{ "data": { "type": "feedback", "attributes": { "interestLevel": "13", "quickResponses": ["15", "18"], "notes": "Optional, max 1000 characters" } } }
```

- `422 viewing_not_started` before the viewing's start time.
- `422 viewing_cancelled` for a cancelled viewing.
- `409 feedback_exists` if feedback has already been recorded.

### `GET /properties` *(paginated)*

- `filter[q]`: matches the address, town or postcode.
- `filter[market]`: `sales` or `lettings`.

### `GET /properties/:id`

### `GET /people` *(paginated)*

- `filter[q]`: matches the name, the email, or 3 or more digits of the phone number.
- `filter[role]`: `applicant` or `owner`.

### `GET /people/:id`

### `POST /people`

Creates an applicant.

```json
{ "data": { "type": "people", "attributes": { "firstName": "Sam", "lastName": "Lee", "phone": "07700 900999", "email": "sam.lee@example.com" } } }
```

- First and last name are required, plus at least one of phone or email.
- `409 duplicate_person` when the email already belongs to someone. `meta.personId` gives that person's id.

### `GET /images/:file`

Static photos. No auth needed. Image resources carry an absolute `url`, built from the host you called.

## Resources

| Type | Attributes | Relationships |
|---|---|---|
| `agents` | `firstName`, `lastName`, `email`, `phone`, `jobTitle`, `branch` | |
| `people` | `firstName`, `lastName`, `email`*, `phone`*, `roles` (`owner`, `applicant`), `requirements`* (`market`, `minBedrooms`, `maxPrice`, `position`) | |
| `properties` | `address` (`line1`, `line2`*, `town`, `city`, `postcode`, `latitude`, `longitude`), `market`, `status`, `price` (`amount`, `currency`, `qualifier`*, `frequency`*), `propertyType`, `bedrooms`, `bathrooms`, `receptions`, `tenure`*, `councilTaxBand`, `epcRating`, `description`, `keyFeatures`, `accessNotes`, `keySafeCode`* | `owner` → people, `images` → images[] |
| `images` | `url`, `width`, `height`, `caption` | |
| `viewings` | `startsAt`, `endsAt`, `status` (`unconfirmed`, `confirmed`, `cancelled`), `cancellationReason`*, `notes`* | `property`, `applicant` → people, `agents` → agents[], `feedback`* |
| `feedback` | `interestLevel`, `quickResponses`, `notes`*, `submittedAt` | |
| `lookups` | `category`, `label`, `value`*, `sortOrder` | |

\* can be `null`.
