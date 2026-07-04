# Runbook — Email for `dokumenty.win` via **Cloudflare Email Routing** (ACTUAL setup)

**Date set up:** 2026-06-29
**Domain:** `dokumenty.win` (DNS hosted on Cloudflare: `west.ns.cloudflare.com`, `thea.ns.cloudflare.com`; A → `157.180.38.103`, Hetzner)
**Purpose:** a business email on the domain **for Facebook / Meta** (app & business contact email).

> ⚠️ This supersedes `EMAIL_DNS_dokumenty_win.md` for `dokumenty.win`. That file assumes
> **Google Workspace** (`smtp.google.com` MX) — **we did NOT use Google Workspace.** We use
> **Cloudflare Email Routing** (free, receive/forward only).

---

## What was configured

- **Service:** Cloudflare → (domain `dokumenty.win`) → **Email → Email Routing** = **Enabled**.
- **DNS records:** added & **Locked** automatically by Cloudflare (verified live with `dig`):

| Type | Host | Priority | Value |
|------|------|----------|-------|
| MX  | `dokumenty.win` | 35 | `route1.mx.cloudflare.net` |
| MX  | `dokumenty.win` | 82 | `route3.mx.cloudflare.net` |
| MX  | `dokumenty.win` | 92 | `route2.mx.cloudflare.net` |
| TXT | `dokumenty.win` | — | `v=spf1 include:_spf.mx.cloudflare.net ~all` |
| TXT | `cf2024-1._domainkey.dokumenty.win` | — | `v=DKIM1; h=sha256; k=rsa; p=…` (managed by Cloudflare) |

- **Routing rule:** **Catch-all → Send to an email → `bizmaksat@gmail.com`** (Active).
  → **Any** address `@dokumenty.win` (`info@`, `admin@`, `office@`, …) is received and
  **forwarded to `bizmaksat@gmail.com`**. No need to create per-address rules.
- **Destination address:** `bizmaksat@gmail.com` — **Verified** (account-level in Cloudflare;
  the Cloudflare account is also logged in as bizmaksat@gmail.com).

**Recommended address to hand to Facebook/anyone:** `info@dokumenty.win`.

---

## Nature & limits

- **Receive / forward only.** There is **no mailbox** and **no outbound SMTP**. You read the
  mail in `bizmaksat@gmail.com`.
- To **send** *as* `…@dokumenty.win` (e.g. reply from that address) you'd need Gmail
  **"Send mail as"** + an SMTP relay — **not set up**. For Facebook verification, receiving is enough.

---

## Verify

```bash
dig +short MX  dokumenty.win @1.1.1.1
dig +short TXT dokumenty.win @1.1.1.1            # SPF
```
Expected: the three `route{1,2,3}.mx.cloudflare.net` MX hosts + the SPF TXT.
Then send a test mail to `info@dokumenty.win` → it should land in `bizmaksat@gmail.com`
(check Spam on the first message).

---

## Gotcha encountered (and the fix)

Email Routing got **stuck**: top bar showed **"DNS records: Not configured"**, `dig` returned
no MX, and there was **no "Add records" button** anywhere. Creating routing rules did not help.

**Fix:** `Email Routing → Settings → Disable` (removes the half-state), then **"Onboard Domain"**
again from scratch. The clean onboarding wizard writes the MX/SPF/DKIM records and **Locks** them;
status then flips to **Enabled**. Confirmed live via `dig` afterwards.

---

## Change / extend later

- **Different forward target:** Email Routing → Destination Addresses → add+verify new Gmail →
  edit the Catch-all rule's destination.
- **Specific address instead of catch-all:** Routing rules → Create routing rule → pattern `info`
  @ `dokumenty.win` → Send to an email → pick destination.
- **Switch to real mailboxes (Google Workspace / Zoho / M365):** you'd replace the Cloudflare MX
  with that provider's MX — see `EMAIL_DNS_dokumenty_win.md`. Don't mix both MX schemes.
