# Support Ticket API Reference

All endpoints require `Authorization: Bearer <token>`. Company is resolved from the authenticated user.

---

## 1. List tickets

```http
GET /api/support-ticket/get-all?scope=user&skip=0&limit=10
Authorization: Bearer <token>
```

**Query params:**

| Param | Type | Description |
|-------|------|-------------|
| `scope` | `user` / `admin` | `user` = own tickets only (default); `admin` = all company tickets (ADMIN only) |
| `skip` | number | Pagination offset (default 0) |
| `limit` | number | Page size 1–100 (default 10) |
| `search` | string | Search subject, ticket_number, user name/email |
| `status` | string | Filter by status enum |
| `priority` | string | Filter by priority enum |
| `category` | string | Filter by category enum |
| `assigned_to` | ObjectId / `"unassigned"` | Filter by assignee |
| `date_from` | ISO date | createdAt >= |
| `date_to` | ISO date | createdAt <= |
| `sortBy` | string | Field to sort by (default `createdAt`) |
| `sortOrder` | `asc` / `desc` | Sort direction (default `desc`) |

**Response:**

```json
{
  "success": true,
  "status": 200,
  "data": [
    {
      "_id": "...",
      "ticket_number": "TCK-000001",
      "subject": "Payment failed",
      "category": "Billing",
      "priority": "high",
      "status": "waiting_for_admin",
      "user": { "_id": "...", "name": "Ali", "email": "ali@example.com" },
      "assigned_to": { "_id": "...", "name": "Admin", "email": "admin@example.com" },
      "unread_count": 2,
      "last_reply_at": "2026-07-29T10:00:00.000Z",
      "createdAt": "..."
    }
  ],
  "pagination": { "skip": 0, "limit": 10, "total": 35 }
}
```

**curl:**

```bash
curl -H "Authorization: Bearer TOKEN" \
  "http://localhost:8000/api/support-ticket/get-all?scope=user&limit=10"
```

---

## 2. Get ticket detail

```http
GET /api/support-ticket/get/:id?scope=user&limit=50
Authorization: Bearer <token>
```

**Query params:**

| Param | Type | Description |
|-------|------|-------------|
| `scope` | `user` / `admin` | Non-admin can only view own tickets |
| `before` | ObjectId or ISO date | Cursor for older messages (infinite scroll) |
| `limit` | number | Messages page size 1–200 (default 50) |

Internal notes (`is_internal: true`) are excluded for non-admin viewers.
Marks ticket as read for the current viewer.

**Response:**

```json
{
  "success": true,
  "status": 200,
  "data": {
    "_id": "...",
    "ticket_number": "TCK-000001",
    "subject": "Payment failed",
    "status": "waiting_for_user",
    "has_more_messages": false,
    "messages": [
      {
        "_id": "...",
        "role": "user",
        "message": "I was charged twice",
        "is_internal": false,
        "user": { "_id": "...", "name": "Ali", "email": "ali@example.com" },
        "attachments": [],
        "createdAt": "..."
      }
    ]
  }
}
```

**curl:**

```bash
curl -H "Authorization: Bearer TOKEN" \
  "http://localhost:8000/api/support-ticket/get/TICKET_ID?limit=50"
```

---

## 3. Create ticket

```http
POST /api/support-ticket/create
Authorization: Bearer <token>
Content-Type: application/json
```

**Body (JSON):**

```json
{
  "subject": "Payment failed",
  "category": "Billing",
  "priority": "high",
  "description": "I was charged twice for order #123"
}
```

**Body (multipart/form-data):**

```bash
curl -X POST -H "Authorization: Bearer TOKEN" \
  -F "subject=Payment failed" \
  -F "category=Billing" \
  -F "priority=high" \
  -F "description=I was charged twice" \
  -F "attachments=@screenshot.png" \
  "http://localhost:8000/api/support-ticket/create"
```

**Enums:**

- `category`: General, Billing, Technical, Sales, Feature Request, Bug Report, Other
- `priority`: low, medium, high, urgent

**Response:** 201 with full ticket document.

---

## 4. Reply to ticket

```http
POST /api/support-ticket/reply/:id
Authorization: Bearer <token>
```

**Body (JSON):**

```json
{
  "message": "Here is additional info",
  "is_internal": false
}
```

**Body (multipart):**

```bash
curl -X POST -H "Authorization: Bearer TOKEN" \
  -F "message=See attached" \
  -F "attachments=@file.pdf" \
  "http://localhost:8000/api/support-ticket/reply/TICKET_ID"
```

**Status flow:**
- User reply → `waiting_for_admin`
- Admin public reply → `waiting_for_user`
- Admin internal note (`is_internal: true`) → status unchanged
- Closed tickets → 400 error

**Response:** 200 with updated ticket + messages.

---

## 5. Change status

```http
PUT /api/support-ticket/change-status/:id
Authorization: Bearer <token>
Content-Type: application/json
```

```json
{ "status": "resolved" }
```

**Allowed statuses:** open, pending, waiting_for_user, waiting_for_admin, resolved, closed

**Rules:**
- Admin can set any status (except reopen closed)
- Non-admin can only set `closed`, and only if current status is `resolved`
- Closed is terminal

**curl:**

```bash
curl -X PUT -H "Authorization: Bearer TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"status":"resolved"}' \
  "http://localhost:8000/api/support-ticket/change-status/TICKET_ID"
```

---

## 6. Change priority (admin only)

```http
PUT /api/support-ticket/change-priority/:id
Authorization: Bearer <token>
Content-Type: application/json
```

```json
{ "priority": "urgent" }
```

**Allowed:** low, medium, high, urgent

**curl:**

```bash
curl -X PUT -H "Authorization: Bearer TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"priority":"urgent"}' \
  "http://localhost:8000/api/support-ticket/change-priority/TICKET_ID"
```

---

## 7. Assign ticket (admin only)

```http
PUT /api/support-ticket/assign/:id
Authorization: Bearer <token>
Content-Type: application/json
```

```json
{ "assigned_to": "USER_OBJECT_ID" }
```

Send `null` or `""` to unassign.

**curl:**

```bash
curl -X PUT -H "Authorization: Bearer TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"assigned_to":"6a60082b3bbbeaaacd9a4d42"}' \
  "http://localhost:8000/api/support-ticket/assign/TICKET_ID"
```

---

## 8. Upload attachment

```http
POST /api/support-ticket/upload-attachment
Authorization: Bearer <token>
Content-Type: multipart/form-data
```

**Fields:**
- `file` (required) — the file
- `ticket_id` (optional) — link to ticket
- `message_id` (optional) — link to message

**Allowed files:** jpg, jpeg, png, gif, webp, pdf, zip, docx (max 10MB)

**curl:**

```bash
curl -X POST -H "Authorization: Bearer TOKEN" \
  -F "file=@document.pdf" \
  -F "ticket_id=TICKET_ID" \
  "http://localhost:8000/api/support-ticket/upload-attachment"
```

**Response:** 201

```json
{
  "success": true,
  "status": 201,
  "data": {
    "_id": "...",
    "name": "document.pdf",
    "filename": "1722268800000_abc123.pdf",
    "url": "http://localhost:8000/uploads/support-tickets/COMPANY/TICKET/1722268800000_abc123.pdf",
    "path": "uploads/support-tickets/COMPANY/TICKET/1722268800000_abc123.pdf",
    "mime_type": "application/pdf",
    "size": 524288
  }
}
```

---

## 9. Delete attachment

```http
DELETE /api/support-ticket/delete-attachment/:id
Authorization: Bearer <token>
```

**Rules:**
- Admin can delete any attachment in company
- Non-admin can delete own attachments only on open tickets

**curl:**

```bash
curl -X DELETE -H "Authorization: Bearer TOKEN" \
  "http://localhost:8000/api/support-ticket/delete-attachment/ATTACHMENT_ID"
```

**Response:**

```json
{ "success": true, "status": 200, "message": "Attachment deleted" }
```

---

## Status Flow

```
User creates          → open
Admin replies (public) → waiting_for_user
User replies          → waiting_for_admin
Admin sets resolved   → resolved
User closes           → closed
Closed is terminal (no reopen)
```
