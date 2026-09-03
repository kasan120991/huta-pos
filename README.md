# Huta POS

A point-of-sale system for a multi-location CBD / hemp-derived cannabinoid retail business,
built to replace an off-the-shelf POS that could not describe what the shop actually sells.

The things that made the old system unworkable are the things this one is designed around:
flower is **bought and sold by weight** with bulk price breaks, a product's **potency** is
part of its identity and part of how customers shop for it, stock is **per store** and moves
between them, and cost is commercially sensitive and must never reach a cashier's screen.

**Status:** feature-complete for daily trading and in use against real catalog data —
selling, payments, refunds, purchasing, receiving, transfers, staff, the timeclock and gross
payroll all work end to end. One admin screen (`/admin/reconcile`) still has a finished
server and no UI. See [What is not built](#what-is-not-built).

---

## Running it

Requires **Node 22+**, **pnpm 11**, and Docker (for PostgreSQL).

```bash
pnpm install
pnpm db:up                    # PostgreSQL 16 in Docker, on host port 55432
pnpm --filter @huta/server prisma:migrate
pnpm --filter @huta/server seed:legacy   # reference data + the real catalog
pnpm dev                      # app on :3000, API on :3001
```

Sign in at <http://localhost:3000/login>. The seed writes dev credentials to
`server/tmp/dev-credentials.txt`, which is gitignored and rewritten on every seed run.

> **Port 55432, not 5432.** Deliberate, so the container never collides with a native
> PostgreSQL install. An IDE database tool connects to `localhost:55432`, database
> `huta_pos`, user and password `huta`.

> **Ports 3000 and 3001 are load-bearing.** The API's CORS allowlist and the Socket.IO
> origin check both name them, and `/api` is proxied through Nitro so cookies stay
> same-origin. Moving either breaks auth in ways that look like something else.

### Working on a tablet

The register is designed for a 1080p touchscreen, and its camera barcode scanner needs a
secure origin — browsers only expose `getUserMedia` over HTTPS. So:

```bash
DEV_TLS=1 pnpm dev
```

This serves **both** the app and the API over TLS from `app/.certs/` (untracked; generate
with openssl, SANs for `localhost` plus the machine's LAN IP). The tablet must trust the CA
for **`:3001` as well as `:3000`** — a Socket.IO handshake is a subresource request, so an
untrusted cert there fails **silently** and realtime simply never connects.

---

## Commands

| Command | What it does |
|---|---|
| `pnpm dev` | App and API together |
| `pnpm typecheck` | All three workspaces |
| `pnpm check:ui` | Compiles all Vue templates and checks `ui/` imports — see below |
| `pnpm test` | Shared + server suites (**269 + 622**) |
| `pnpm db:up` / `db:down` | The PostgreSQL container |
| `pnpm --filter @huta/server prisma:studio` | Browse the database |
| `pnpm --filter @huta/server seed` | Reference data only (idempotent) |

⚠️ **Never run two `pnpm test` invocations at once.** Both vitest projects share one test
database and reset it unconditionally, so concurrent runs truncate each other mid-test and
produce hundreds of meaningless failures. If a run fails broadly and catastrophically, look
for a second run before reading a single stack trace.

⚠️ **`pnpm typecheck` does not check Vue templates** (`typescript.typeCheck` is off). That is
what `pnpm check:ui` is for — it compiles all 225 SFC templates and flags any `ui/` component
used but not imported, because Vue logs an unresolved component as a *warning* and renders
nothing. Every UI change is also verified in a real browser before it is called done.

---

## Layout

pnpm workspaces monorepo.

```
app/       Nuxt 4 SPA — register surface and back office (shadcn-vue + Tailwind v4)
server/    Express 5 + Prisma 7 + Socket.IO API
shared/    @huta/shared — the contract between them: money, units, pricing, enums
_archive/  the pre-2026-08-18 PrimeVue frontend, kept for reference
```

`shared/` is the contract, and three things about it are structural rather than stylistic:
its root entry has **zero runtime dependencies** (Zod lives behind the `/schemas` subpath, so
importing a formatter into a Vue component does not pull Zod into the register bundle); its
tsconfig sets `"types": []` with no DOM lib, which makes "safe on both a server and a
browser" a compile-time guarantee; and it builds to `dist/` rather than exporting raw TS, so
a plain `tsc` server build works.

If both sides need a type, it goes in `shared/`. Do not duplicate one across `app/` and
`server/`.

---

## The rules that are not negotiable

Most of these exist because breaking them costs money or inventory rather than a bug report.

- **Money is integer cents.** Never a float, never a `Decimal`. Format to dollars only at the
  display layer. Rounding is half **away from zero** via one shared helper — not
  `Math.round`, whose asymmetry means refunding a taxed line returns a cent less than was
  charged.
- **Quantities are integers in a base unit** — 1 item for `EACH` products, 1 **milligram**
  for `WEIGHT` ones. So 3.5 g is `3500`. Conversion happens only through the helpers in
  `shared/`, and parses the decimal *string*, because `3.53 * 1000` is `3530.0000000000005`.
- **The server is the single source of truth.** The client computes nothing that touches
  money or stock; it renders what the server returns. A client-supplied `storeId`, price,
  total or quantity is never trusted.
- **Stock changes are transactional and append-only.** Every quantity change goes through one
  service that writes an `InventoryMovement` in the same transaction. Nothing `UPDATE`s a
  quantity directly.
- **Cost never reaches a staff principal.** Not hidden in the UI — omitted from the payload
  server-side. Tests assert this in *both* directions, because asserting a staff response has
  no cost key means nothing unless the same call as an admin is asserted to have one.
- **Never delete a sale, payment, refund or inventory movement.** Void and reverse instead;
  these records are the audit trail.
- **Snapshot onto historical records** — price, cost, tax rate, supplier, applied tier and
  promotion all land on the sale line. Reporting never joins to a product's *current*
  supplier or price.

The database enforces a lot of this itself: **49 tables, 17 enums and 88 CHECK constraints**
across 22 migrations. Constraints encode invariants Prisma's schema language cannot express —
staff are store-scoped and admins are not, stock cannot go negative, a movement's sign must
match its type, a closed shift is fully reconciled, payroll's overtime arithmetic is asserted
in SQL. They are a backstop behind the service layer, not a replacement for it.

---

## A few things that will otherwise cost you an afternoon

- **Socket.IO is deliberately not proxied through Nitro in dev.** The dev proxy cannot hold a
  long-polling connection: it dies on `ECONNRESET`, takes the dev server with it, and
  crash-loops. The client connects straight to `:3001`; cookies still work because SameSite
  is evaluated per *site* and ports are not part of one.
- **Prisma 7 is not Prisma 6.** The connection URL lives in `server/prisma.config.ts`, not the
  schema; the client needs a driver adapter; the generator is `prisma-client` with an explicit
  output. Also — and this has bitten twice — Prisma 7 with the pg adapter **does not populate
  `meta.target` on P2002**, so the unique-violation check that every Prisma 5/6 example shows
  silently never matches.
- **Count schema objects against the database, never by grepping migration SQL.** A
  `DROP`/`ADD CONSTRAINT` pair in a later migration over-counts.
- **Business days are cut in the store's timezone**, through one module. A bare
  `new Date('2026-08-22')` is parsed as **UTC midnight**, so the day ends at 20:00 Eastern and
  the whole evening lands on tomorrow. That bug has been written four times; there is now one
  place the rule may live.
- **Vendored shadcn-vue components can out-specify your utilities.** A component's *modified*
  class (`data-[size=default]:h-8`) beats your plain `h-10`. Grep the component for the
  property before setting it.

---

## What is not built

- **`/admin/reconcile`** — the flower weight-count screen. Its server API is complete and
  tested; only the UI is missing. This is the last stub.
- **The dashboard** at `/` is a placeholder. `GET /shifts/live` was built to fill it.
- **A promotion builder** — promotions resolve correctly and are fully tested, but can only
  be created in psql today.
- **No frontend tests.** Every UI claim is verified by driving a real browser, not by
  something that runs in CI. This is the largest gap in the suite.

Deferred on purpose: Stripe Terminal (card-present), offline mode, batch/lot tracking (the
schema is ready and the columns exist), sending purchase orders to suppliers, e-commerce, and
employee scheduling — the timeclock records what happened, not what will.

---

## Where the detail lives

⚠️ The architecture source of truth is **`the house rules`, which is deliberately untracked** and
exists only on the maintainer's machine. It carries the reasoning behind every decision
above, plus the ones this file only summarises. This README is the whole of the orientation
that ships with the repo — if you are picking this up from a clone alone, expect to read the
code for the *why*.

Private repository. All rights reserved; no licence is granted.
