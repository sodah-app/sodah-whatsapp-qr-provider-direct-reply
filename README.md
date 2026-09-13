# Sodah WhatsApp QR Provider — Direct Reply Version

This version does **not use n8n**.

Flow:

WhatsApp → Baileys → businessId → Supabase business configuration → AI → WhatsApp reply

## 1. Install

```powershell
npm install
```

Create `.env` from `.env.example` and fill in:

- `PROVIDER_API_KEY`
- `OPENAI_API_KEY`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

If AI is not configured, set `AI_ENABLED=false`. The provider will still receive messages but will not generate AI replies.

## 2. Start

```powershell
npm start
```

Keep this PowerShell window running.

## 3. Important routes

Health:

`GET /health`

Create a session:

`POST /session/create`

Status:

`GET /session/:sessionId/status`

QR:

`GET /session/:sessionId/qr`

Send:

`POST /session/:sessionId/send`

Logout:

`POST /session/:sessionId/logout`

Delete:

`DELETE /session/:sessionId`

## Multi-tenant behavior

The connected session is tied to a `businessId`.

For every incoming message, the provider:

1. identifies the WhatsApp session;
2. obtains that session's businessId;
3. loads that business's configuration from Supabase;
4. sends only that business configuration to the AI;
5. replies through the same WhatsApp session.

It does not use n8n.

## Expected business columns

The defaults are:

- `business_id`
- `business_name`
- `ai_prompt`
- `ai_number`
- `whatsapp_connected`

If your actual prompt column has another name, change `BUSINESS_PROMPT_COLUMN` in `.env`.

## Message persistence

If `SAVE_MESSAGES=true`, the provider attempts to insert messages into:

`whatsapp_messages`

Recommended columns:

- `business_id`
- `session_id`
- `message_id`
- `direction`
- `phone_number`
- `message_text`
- `created_at`

The provider will not crash if the optional persistence table is unavailable.

## Customer persistence

If `SUPABASE_CUSTOMERS_TABLE` exists, the provider attempts to upsert basic customer information. This is also non-fatal.

## First test

After WhatsApp is connected, send:

`Hi`

to the connected number from another WhatsApp account.

The terminal should show:

`Incoming WhatsApp message`

then:

`AI reply generated`

then:

`WhatsApp reply sent`

Do not run a second copy of the provider on port 3001.
