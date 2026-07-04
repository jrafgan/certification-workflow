# Runbook — Email DNS for `dokumenty.win` (MX · SPF · DKIM · DMARC)

**Date:** 2026-06-24
**Domain:** `dokumenty.win` (a separate domain — *not* `dokumenty.pro`, which the app uses).
**Problem being fixed:**
1. **Mail can't be delivered to `@dokumenty.win`** — the zone has no **MX** record, so no
   mail server is published to receive for the domain.
2. **`@dokumenty.win` can be spoofed** — without **SPF + DKIM + DMARC**, anyone can forge
   `From: …@dokumenty.win` and receivers have no way to detect it.

> ⚠️ **Where this is applied:** at `dokumenty.win`'s **DNS host** (the registrar /
> nameserver control panel). It is **not** in this repository — there is no DNS-as-code
> here. This runbook is the source of truth for *what* to set; whoever holds DNS access
> applies it.

> ⚠️ **Provider assumption:** values below assume **Google Workspace** (the business runs on
> Gmail). If mail is hosted elsewhere, replace the **MX**, the **SPF `include:`**, and the
> **DKIM selector/key** with that provider's values — see *Other providers* at the bottom.
> **DMARC is identical for every provider.**

---

## 1. MX — receive mail (Google Workspace)

Google Workspace now uses a **single** MX host.

| Type | Host (name) | Priority | Value |
|------|-------------|----------|-------|
| MX   | `@` (`dokumenty.win`) | `1` | `smtp.google.com.` |

> Legacy Google setups used 5 records (`aspmx.l.google.com` + `alt1–4`). The single
> `smtp.google.com` record is the current standard; don't mix the two schemes.
> Note the trailing dot — most panels add it automatically; some require it.

**Other hosts:** Zoho → `mx.zoho.com` (10), `mx2.zoho.com` (20), `mx3.zoho.com` (50).
Microsoft 365 → `<tenant>.mail.protection.outlook.com` (0).

---

## 2. SPF — authorize who may *send* as `@dokumenty.win`

Exactly **one** SPF TXT record per domain (multiple SPF records = permanent failure).

| Type | Host | Value |
|------|------|-------|
| TXT  | `@`  | `v=spf1 include:_spf.google.com ~all` |

- `~all` (softfail) during rollout. Tighten to `-all` (hardfail) once you've confirmed
  nothing legitimate is sending from outside Google.
- If another system also sends as this domain (e.g. SES/Mailgun/the app's SMTP), add its
  include **inside the same record**, e.g.
  `v=spf1 include:_spf.google.com include:amazonses.com ~all`.
- Keep total DNS lookups ≤ 10 (an SPF hard limit).

**Other hosts:** Zoho → `include:zoho.com` · M365 → `include:spf.protection.outlook.com`.

---

## 3. DKIM — cryptographically sign outbound mail

DKIM **cannot be written blind** — the provider generates the key pair and gives you the
**public key**; you publish it as TXT.

**Google Workspace steps:**
1. Admin console → **Apps → Google Workspace → Gmail → Authenticate email**.
2. Select `dokumenty.win` → **Generate new record** (choose **2048-bit**). Selector is
   `google` by default.
3. Google shows a host and a long value. Publish:

| Type | Host | Value |
|------|------|-------|
| TXT  | `google._domainkey` | `v=DKIM1; k=rsa; p=<LONG-PUBLIC-KEY-FROM-GOOGLE>` |

4. Wait for propagation, then click **Start authentication** in the console.

> If your DNS panel caps TXT value length, split the key into multiple quoted strings
> on one record — most panels handle 2048-bit keys natively now.

**Other hosts:** Zoho → selector from its DKIM page at `<selector>._domainkey`.
M365 → enable DKIM in the M365 admin; it publishes **two CNAMEs** (`selector1`/`selector2`
`._domainkey`) rather than a TXT.

---

## 4. DMARC — tell receivers what to do with spoofed mail (provider-independent)

Publish **after** SPF + DKIM are live and verified, so legitimate mail already passes.

| Type | Host | Value |
|------|------|-------|
| TXT  | `_dmarc` | `v=DMARC1; p=none; rua=mailto:dmarc@dokumenty.win; ruf=mailto:dmarc@dokumenty.win; fo=1; adkim=s; aspf=s` |

**Staged rollout — do not jump straight to reject:**
1. **`p=none`** (monitor) — collect aggregate reports for ~1–2 weeks, confirm all
   legitimate sources pass SPF/DKIM.
2. **`p=quarantine`** — spoofed mail goes to spam. Optionally `pct=25` then ramp to 100.
3. **`p=reject`** — spoofed mail is dropped. This is the end state that fully stops spoofing.

- `rua`/`ruf` must point to a mailbox that **exists** (a `@dokumenty.win` address you can
  receive at — which requires step 1's MX to be working first).
- `adkim=s; aspf=s` = strict alignment. Relax to `r` (relaxed) if a legitimate sender
  fails alignment in the reports.

---

## 5. Verify (after DNS propagates — minutes to a few hours)

```bash
dig +short MX    dokumenty.win
dig +short TXT   dokumenty.win                       # SPF
dig +short TXT   google._domainkey.dokumenty.win     # DKIM (selector may differ)
dig +short TXT   _dmarc.dokumenty.win                # DMARC
```

Then send a test message **from** a `@dokumenty.win` account to a Gmail address, open
**Show original**, and confirm **SPF: PASS**, **DKIM: PASS**, **DMARC: PASS**.

---

## Checklist

- [ ] MX published (`smtp.google.com`, pri 1) — inbound mail now deliverable
- [ ] Single SPF TXT (`~all` first)
- [ ] DKIM key generated in provider console + TXT published + authentication started
- [ ] DMARC `p=none` with a reachable `rua` mailbox
- [ ] Verified PASS/PASS/PASS via a test message
- [ ] Tighten: SPF `~all → -all`, DMARC `none → quarantine → reject`
