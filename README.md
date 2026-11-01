# AquaTrack — Smart Water Supply & Meter Management System

A working web application for water utilities, community water providers and WASH projects in Liberia.
It runs customer accounts, meter registry and readings, billing and payments in **USD and LRD**, leak and
consumption alerts, work orders, a network asset register, dashboards and CSV reports. It works with
ordinary meters read by hand today and has an integration layer for smart meters when real connections are arranged.

- **No external dependencies.** Node.js 22.5 or newer and its built-in SQLite. Nothing to compile and no `npm install`.
- **Responsive.** Works on desktop, tablet and phone. The meter-reading screen works **offline**.
- **Demo and live data are kept apart.** They use separate database files, and every demo screen, document and CSV is marked DEMO.

**Built for how water is actually used and paid for in Liberia:**

- **Any phone, no data bundle.** Customers dial a USSD code or text `BAL`, `BILL`, `READ 1234`, `LEAK …` to check bills, send their own readings and report leaks. They get SMS bills and receipts.
- **Mobile money reconciles itself.** MTN MoMo and Orange Money payments are matched automatically by account or water-card number, then by sender phone. They arrive by provider callback or by uploading the merchant statement CSV. Only leftovers wait for a cashier.
- **Photo meter reading.** A reader or customer photographs an ordinary meter and the phone reads the number on the device, offline. The person still confirms the value, and any disagreement with the photo is flagged. Cheap mechanical meters start producing checked data without smart-meter hardware.
- **Pay-as-you-fetch water points.** Kiosk and tap-stand attendants sell by the container (cash, prepaid water card or free) on a phone that works offline. Sales are checked against the tap meter, and cash against handovers.
- **Water-loss intelligence and a public page.** IWA-style water balance by area, an estimate of the money lost, a ranked list of accounts to inspect, and a shareable aggregate page for donors, regulators or communities. It shows no personal data.
- **Community status & closed-loop reporting.** Anyone, with or without an account, can report a leak, burst, outage or bad water at `/status`, by USSD or by SMS. They get a reference number and an SMS when it is fixed. The same page shows supply status, water points, prices and water-quality results per area.
- **Water quality you can see.** Chlorine, E. coli, turbidity and pH tests are checked against editable thresholds. A failed test raises an alert, publishes a "treat your water" advisory and SMSes the area. A passing re-test lifts the advisory automatically.
- **Humane collections.** Friendly SMS reminders, instalment payment plans and a staged ladder. A manager decides every disconnection review, nothing is automatic, and clinics, schools and water points are never put forward for disconnection.
- **Tariff & affordability lab.** Re-price real past bills under a proposed tariff to see revenue, how many bills go up, lifeline cost, bills above the affordability line, and how many times more kiosk users pay per m³ than piped households.
- **Smart routes & a morning briefing.** An offline route optimiser for meter readers and technicians, and a ranked daily priority list for managers (in the app or by SMS).
- **New connections people can afford.** Apply online at `/status`, by USSD or at the office, then: survey, quote, accept, install, connect. A deposit opens the account, and the rest of the connection fee is spread over monthly instalments that appear as their own line on the water bill. Applicants get an SMS at every step and can track their `C-` reference.
- **Shared compound connections.** One meter, several households: each bill is split equally, by household size or by fixed percentages. Every household gets its own SMS and mobile-money reference (`<account>-<household no.>`), so each can pay its part.
- **Cost recovery & performance indicators.** Enter monthly running costs (fuel, chlorine, staff, repairs) and see operating-cost coverage, collection efficiency, NRW, cost per m³, staff per 1,000 connections, hours of supply and more against your own targets. Exports to CSV for boards, regulators and funders.
- **Bring in existing records.** Import a utility's old ledger from CSV: customers (keeping their old account numbers), meters and opening balances. Every file is checked row by row first, imports are all-or-nothing, and re-importing never creates duplicates.
- **Supply timetables for rationed systems.** Publish when water flows to each zone. Customers get an SMS before their water comes on (text `SUPPLY` for the next time, `SUPPLY OFF` to stop), outages cancel the window with an explanation, and operators log the hours actually delivered to measure reliability.
- **Stores.** Pipe, fittings, meter parts and chlorine with receipts, issues to work orders, returns, routine use and adjustments, all as immutable movements. Low stock shows on the morning briefing, and each work order shows the materials it used and their cost.
- **Meter replacement planner.** Estimates how much old mechanical meters under-read, what that costs in unbilled water each year, and ranks replacements by payback. One click creates the replacement work order.
- **"How did we do?" by SMS.** After a repair or a resolved report, the customer can reply 1–5 with a comment. Ratings of 1–2 raise a call-back alert, and scores are reported by area and technician and feed the performance indicators.
- **Preventive maintenance and functionality.** Service plans for pumps, generators, chlorinators and tanks, by days and/or run-hours (whichever comes first). Hour-meter readings recorded in the field project when service falls due, work orders are created automatically, and completing them resets the plan. Every status change is logged, so each water point's functionality %, breakdowns and typical repair time are reported.
- **Service levels for donors (SDG 6.1).** Estimates how many people are at each rung of the WHO/UNICEF JMP drinking-water ladder (safely managed, basic, limited) per area. It uses connections, household sizes, people per water point, collection times, hours of supply and E. coli results, and shows the basis and data gaps behind every figure.
- **Cashier end-of-day close.** Each cashier counts the drawer per currency against their own cash receipts. Any difference must be explained and is reviewed by a different person. After closing, no more cash can be taken that day until a manager reopens it. A cash book lists days not closed.
- **Multilingual, for any country.** English, French and Portuguese for screens, SMS and USSD, chosen per staff member and per customer (customers can switch by USSD option 9 or by texting `LANG FR`; local keywords like `SOLDE` or `SALDO` work too). A built-in translation editor with CSV export/import lets a utility correct the wording or add any language (including right-to-left ones). A country profile sets currencies (any ISO code), currency symbols, phone dialling code and number length, time zone and the mobile-money providers people use, starting from presets for 16 African countries.
- **Two-factor sign-in.** Authenticator-app codes with one-time recovery codes, which can be required by role, plus a "signed-in devices" page to sign out lost phones.

---

## 1. Quick start (demo)

```bash
# Requires Node.js 22.5+  (check: node --version)
cd aquatrack
npm run seed-demo        # builds the fictional demo database (data/demo/)
npm run demo             # http://localhost:3000
```

Sign in with any demo account. The password for all of them is **`DemoPass2026`**. The login page has buttons that fill these in for you.

| Username | Role | What to try |
|---|---|---|
| `admin` | System Administrator | Users, service areas, tariffs, settings and exchange rates, meter integrations, alert rules, backups, audit log |
| `manager` | Utility Manager | Dashboard, alerts, work orders, approving adjustments, notices, bulk supply |
| `reader1` | Meter Reader (Riverside area only) | Field reading on a phone, including offline |
| `reader2` | Meter Reader (Hilltop area only) | Same as reader1, for a different area |
| `tech1`, `tech2` | Technician | Assigned work orders, inspections, asset readings |
| `cashier`, `billing` | Cashier / Billing Officer | Reading review, bill generation, payments, reversals, statements |
| `attendant1`, `attendant2` | Water Point Attendant | Kiosk sales screen on a phone (Greenvale tap stand / Riverside kiosk), works offline |
| `customer1`, `customer2` | Customer | Customer portal (own account only), including Send my meter reading with photo |

`npm run seed-demo` also prints a link to the demo **public / donor page** (`/t/…`). The **community status & reporting page** is at `/status`. Neither needs a login.

Run the automated end-to-end test. It uses a temporary database and leaves yours alone:

```bash
npm test     # 314 checks: first-release flows, USSD/SMS, mobile money, water points, OCR flags, water balance, community reporting, water quality, payment plans, tariff lab, routes, new connections & financing, shared compounds, indicators, onboarding imports, two-factor sign-in, supply timetables, stores, meter replacement, SMS feedback, languages and country settings, maintenance, service levels, cash close, privacy, permissions, tamper protection
```

## 2. First-release workflows (where to click)

| # | Flow | Where |
|---|---|---|
| 1 | Create a service area, tariff, customer and meter | Administration › Service areas / Tariffs → Customers › New customer → Meters › Register meter (or assign a meter from the customer page) |
| 2 | Enter or import a reading | Field reading (phone, works offline) · Readings review › Manual entry · Readings review › Import CSV |
| 3 | Review and approve a reading | Readings review: filter by flag, view the photo or GPS, then Approve, Correct (the original is kept) or Reject |
| 4 | Generate a bill and record a payment | Bills › Generate bills (preview first, then issue) → bill › Record payment → printable receipt |
| 5 | View the account statement | Customer › Account statement (printable), or Customer portal › Statement |
| 6 | Raise a consumption or leak alert and assign a work order | Alerts › Run alert checks / Raise alert → Work order → Technician updates it → linked alert resolves |
| 7 | View dashboards and download a report | Dashboard (filter by date, area and customer type) → Reports (CSV) |

| Flow | Where |
|---|---|
| Customer uses a basic phone | SMS & USSD › Phone simulator: dial, check the bill, send a reading, report a leak. The results appear in Readings review and Alerts |
| Mobile-money payment arrives | Mobile money › Simulate incoming payment (demo) or Import provider statement (CSV) → auto-matched, with an SMS receipt → leftovers in "Needs matching" |
| Reading from a photo | Field reading › meter › Photo of register → drag a box over the black digits → Read numbers. Readings review › flag "Entered value differs from photo OCR" |
| Kiosk sale | Sign in as `attendant1` on a phone → tap a container count (cash or water card), offline or online → Water points › Reconciliation |
| Find where water is lost | Water-loss intelligence → water balance by area → "Inspect" an account (creates a work order) → Create public / donor link |
| Community member reports a burst | Open `/status` (no login) → Report a problem → keep the reference → staff resolve the alert → the reporter gets an SMS → Track my report shows "Resolved" |
| Unsafe water | Water quality › Record test (or the attendant's chlorine check on the kiosk screen) → a fail raises an alert and a public advisory with SMS → a passing re-test lifts it |
| Customer behind on bills | Collections › ladder → Offer plan (schedule preview; SMS to customer) → reminders before each instalment → plan health tracked |
| Test a new tariff | Tariff & affordability lab → load a current tariff → change the bands → Run simulation → save as an inactive draft for approval |
| Start the day | Morning briefing (manager home page) → Send to my phone. Meter reader: Field reading → Plan my route |
| New connection | `/status` › Apply for a connection (or New connections › New application, or USSD option 4) → Book site survey → Record survey → Prepare quote (suggested from standard costs in Settings) → Customer accepts (deposit + instalments; account opened) → deposit paid → Book installation → Connect (choose an in-stock meter). The first bill carries instalment 1/N |
| Several households on one meter | Customer › Shared compound tab › Set up sharing → the current unpaid bill and every new bill are split; each household pays with ref `<account>-<n>` (mobile money) or at the cash desk |
| Does the tariff cover costs? | Cost recovery & KPIs → Add running cost / Staff & supply hours each month → indicators per area against targets → Export CSV |
| Switch an existing utility over | Bring in records → download the templates → Check file → fix any errors → Import (customers, then meters, then opening balances) |
| Rationed supply | Supply timetable › + Schedule (area, zone, days, times) → set each customer's zone on their account → heads-up SMS go out automatically before each window → Delivery log › record hours delivered (reason if short) → reliability per area and in Cost recovery & KPIs |
| Repair with materials | Work order › Take from stores (issue) → Return unused → materials cost shown on the job. Stores › Receive / Use (e.g. chlorination) / Adjust (stock count) |
| Old meters | Meter replacement planner → sort by payback → Plan replacement (creates the work order). Tune the wear assumptions in Settings |
| Customer satisfaction | Complete a repair job for a customer with a phone → they get "reply 1–5" → reply arrives (SMS simulator: send `2 too slow`) → Customer feedback page; low scores also appear in Alerts |
| Keep pumps running | Maintenance › + Service plan (e.g. every 250 h or 90 days) → technician records the hour meter on the asset page → work order created when due → completing it resets the plan. Maintenance › Functionality for uptime and breakdowns |
| Report to a donor | Enter area populations (Administration › Service areas) and, for water points, people served and collection time → Service levels (SDG 6.1) → Export CSV |
| End of the day at the cash desk | Cash close › count each currency → submit (explain any difference) → manager approves or rejects in Cash book |
| Another language or country | Administration › Country & languages → apply a country preset (then check providers, symbols and merchant numbers, add exchange rates) → choose the default language. Staff pick their own language under their name in the menu; set a customer's SMS language on their account. Translate › SMS & USSD messages / Screen text, or Export CSV for a translator and Import it back |
| Protect accounts | Sidebar › Security → Set up two-factor sign-in. Admin › Settings › "Require two-factor sign-in for roles"; Admin › Users › Reset 2FA for a lost phone |

## 3. What is simulated, and what is real

| Feature | Status |
|---|---|
| Manual readings, CSV import, offline field capture, review, billing, payments, statements, alerts, work orders, assets, dashboards, reports, audit log, backups | **Fully working**, with data stored in the database |
| **Demo Meter Simulator** (admin › Meter integrations) | **Simulated.** Generates fictional readings for 4 Hilltop meters. Every simulated reading, bill and alert is labelled **SIMULATED**. Simulated readings **can never be approved in live mode** |
| Hilltop reservoir level "sensor" data | **Simulated** (labelled), for demo only |
| Pulse, LoRaWAN, NB-IoT and cellular, Wireless M-Bus/OMS, serial, and vendor-API adapters | **Implemented as generic adapters but not connected to any real device.** None is verified against a real meter model. The two example integration profiles in the demo are "Information required — not connected" |
| Meter models in the capability registry | **Generic placeholders** (`Generic (demo)`). Replace them with the exact vendor models and confirm what each supports from vendor documentation |
| Payments | Recorded by staff (cash, MTN MoMo, Orange Money, bank, cheque), or posted automatically from mobile-money transactions. Card data is refused |
| **SMS / USSD gateway** | **Simulator.** The menus, keyword handling, alerts and readings they create are real. No SMS is actually sent: outbound messages are stored with status "simulated". The aggregator endpoints `/api/gateway/ussd` and `/api/gateway/sms` are built but have not been connected to a real aggregator |
| **Mobile money** | Matching, receipts, the duplicate guard and statement-CSV import **work now**. The merchant-portal CSV import is the practical way to start without any API. The provider callback `/api/gateway/momo/{mtn,orange}` accepts a generic JSON format and has **not** been verified against MTN or Orange's actual callback specification. The demo "Simulate incoming payment" creates transactions and payments labelled **SIMULATED** and is disabled in live mode |
| **Photo OCR** | **Real, on the device** (tesseract.js is bundled under `public/vendor/`, Apache-2.0). It is only a *suggestion*: the reader or customer confirms the value, and a mismatch is flagged. It reads clear, well-framed register photos best. Accuracy on worn, fogged or glare-covered meters will be lower. The demo meter photos are generated images, not real meters |
| Community status page and no-login reporting, water-quality monitoring and advisories, payment plans, reminders and escalation ladder, tariff lab, morning briefing, route optimiser | **Fully working.** SMS they send (acknowledgements, "fixed" notices, advisories, reminders, briefing) go through the SMS simulator until a gateway is connected. Water-quality thresholds are WHO-based defaults and must be confirmed against the national standard. Income figures for affordability are assumptions you enter. Routes use straight-line distance (not roads) |
| Water points, water cards, cash handovers, water balance, revenue-protection list, public page | **Fully working** on demo data. Apparent and real losses depend on percentage assumptions you set, and are labelled as estimates |
| New connections, connection financing, shared compounds, performance indicators, onboarding import, two-factor sign-in | **Fully working.** Demo connection costs (US$35 fee, US$1.50/m pipe, US$45 meter) and all demo running costs are fictional. Indicators are only as good as the costs and supply volumes entered; default targets are indicative. Applicant and household SMS go through the simulator |
| Supply timetables, stores, meter replacement planner, SMS feedback | **Fully working.** Under-registration and lost revenue are **estimates** from wear assumptions in Settings (defaults are indicative; calibrate with bench tests). Supply SMS, feedback requests and replies go through the SMS simulator. Demo timetables, stock, delivery records, older meter ages and ratings are fictional |
| French and Portuguese translations, country presets | **Working, needs review.** All customer SMS/USSD messages and the most-used screens (customer portal, field reading, kiosk, public status page, sign-in, menus, bills and receipts, dashboard, work orders) are translated; other office screens are partly translated and show English where a phrase is missing (coverage is shown per language). Translations were written for this release and should be checked by native speakers. Country presets are starting points: mobile-money products and phone lengths change, so confirm them locally. Text typed by staff (notices, notes, names) is never translated |
| Maintenance, functionality, service levels, cash close | **Fully working.** Service levels are **estimates**: area populations, people per water point and collection times are entered by the utility, and "available when needed" uses the hours of supply (threshold in Settings, default 12 h/day). Demo maintenance history, run-hours, populations and cash closes are fictional |
| Prepaid accounts | **Future-ready only.** Credit top-ups are recorded and consumption is charged against the credit. There is no token vending or prepaid-meter integration |
| Maps | "Map-ready": GPS on customers, meters, assets, alerts and readings, with OpenStreetMap links, GeoJSON export, and an offline position plot. No tiled basemap is bundled |
| Exchange rate USD→LRD 190 in the demo | **Demo placeholder.** Set real rates under Settings |
| Demo tariffs | Fictional training values. They are not official rates |

The app does not claim a device connection unless an integration's status is **"Verified live integration"**. To reach that status:

1. All required information is entered.
2. An API key is issued.
3. Real messages are received. Until verification, readings from them are flagged *"From an integration that is not yet verified"*.
4. An administrator records how the readings were checked against the physical meter display.

Any later technical change returns the integration to *not verified*.

## 4. Information needed to connect a real meter model or network

Before an integration can receive data, enter all of the following in **Administration › Meter integrations**. The system enforces this.

1. **Exact meter make and model**, including the firmware and radio/register module part number and version.
2. **Communication band or network**, for example: LoRaWAN regional plan (EU868, US915 and so on, confirmed with the vendor and the LTA); NB-IoT/LTE-M band, SIM operator (Orange, Lonestar Cell MTN) and APN; wM-Bus mode (T1/C1/S1, 868 MHz); RS-485 or optical port.
3. **Protocol**, for example: LoRaWAN version and class, OMS version / EN 13757-4, MQTT or HTTPS webhook, Modbus RTU, M-Bus, or the vendor REST API version.
4. **Data or payload format.** Field list, units, scaling, timestamp format, alarm/status bits, and the payload decoder (codec) or byte layout.
5. **Encryption and key handling.** For example: LoRaWAN AppKey/NwkKey custody, OMS AES-128 mode 5/7 keys for each meter, TLS requirements, and who holds the keys.
6. **API, gateway or network-server documentation reference**, with document title and version, or URL.
7. **Vendor access requirements.** Accounts, licences, NDA, network-server tenancy, test meters, support contact and SLA.

Per method, the system also needs:

| Method | Additional details |
|---|---|
| Pulse-output retrofit | Litres per pulse, the starting register value at fitting, the module's uplink transport (LoRaWAN, NB-IoT or other) and whether pulses are cumulative or delta |
| LoRaWAN | Network server (ChirpStack, The Things Stack, or vendor), DevEUIs, a payload codec that outputs a register volume in m³, gateway locations, and uplink interval |
| NB-IoT / cellular | Vendor cloud push or pull API, authentication, device IDs, reporting interval, SIM/data plan, and coverage confirmation at sites |
| Wireless M-Bus / OMS | Gateway or drive-by collector that decrypts and decodes telegrams to JSON, meter IDs, and AES keys for each meter |
| Serial / vendor API | Collector hardware or software, port settings (baud, parity), register map, and the API base URL, auth and rate limits |

Inbound endpoint: `POST /api/ingest/<integration id>` with header `X-Api-Key: <key>`. The adapters accept JSON (ChirpStack v4 uplink, The Things Stack v3 webhook, or generic JSON with a configurable field mapping). See `server/integrations/index.js`. Raw OMS telegram decryption and LoRaWAN payload decoding happen in the gateway or network server, not in this app.

### Needed to make the new channels live

| Channel | What you need |
|---|---|
| USSD | A USSD short code from an aggregator or from MTN (Lonestar Cell) and Orange Liberia, plus the aggregator's callback format (session ID, phone, text; reply as `CON`/`END` text is the common convention) and IP allow-list details. Then issue a gateway key under SMS & USSD › Gateway setup |
| SMS | Sender ID or long number, aggregator API credentials and delivery-report format, and per-message cost. Outbound sending to a real provider still has to be added (`server/services/channels.js` › `send()`): it currently stores messages only |
| MTN MoMo / Orange Money | A merchant collection account for each. Either (a) a statement export, which works today via CSV import, or (b) API/callback access: the API documentation, sandbox credentials, the callback signature or verification method, and field names for transaction ID, payer number, amount, currency and reference. The callback mapping in `server/modules/channels.js` must be checked against the real specification before use |
| Water cards | Printed card numbers (or the phone numbers used as cards), a committee pricing decision per container, and attendant phones (any Android with Chrome) |

## 5. Going live

**Online with Cloudflare + automatic updates from GitHub:** see [DEPLOY.md](DEPLOY.md). It covers a one-command server setup (`deploy/install.sh`), a Cloudflare Tunnel on your domain, and tested, backed-up updates with automatic rollback on every push. The steps below are the manual equivalent.

```bash
# 1. Create the first administrator in the separate LIVE database (data/live/)
APP_MODE=live npm run create-admin -- yourname "Your Full Name"     # prompts for password

# 2. Start in live mode (default port 8443; set PORT to change)
APP_MODE=live PORT=8080 npm run live
```

Then, as admin: add service areas → tariffs → exchange rates → users → customers and meters. Live mode has **no demo data and no simulator**. Seeding demo data into it is refused.

**HTTPS (required for real use).** Run behind a TLS reverse proxy. Caddy example:

```
water.example.org {
    reverse_proxy 127.0.0.1:8080
}
```

Set `COOKIE_SECURE=1` when behind HTTPS. Alternatively, run TLS directly with `TLS_CERT=/path/cert.pem TLS_KEY=/path/key.pem`. Phones need HTTPS for GPS, the camera and offline install.

**Keep it running** with `systemd`, `pm2`, or a Windows service wrapper. A small server, mini-PC or Raspberry Pi 4/5 with a UPS is enough for thousands of accounts.

Environment variables (country, currency and language are set in the app, not here): `TRUST_PROXY` (`cloudflare` behind Cloudflare Tunnel, `1` behind a local reverse proxy; forwarded IPs are ignored otherwise), `APP_MODE` (demo|live), `PORT`, `HOST`, `DATA_DIR`, `TLS_CERT`, `TLS_KEY`, `COOKIE_SECURE`, `AQ_SECRET_KEY` (encrypts two-factor secrets; if unset a key file is created in the data folder).

## 6. Backups and restore

- An automatic backup runs daily while the server is on (`data/<mode>/backups/`). The last N are kept; set N in Settings.
- Use **Administration › Backups** to back up now or download a backup. Keep copies off-site, for example on an encrypted USB drive or in cloud storage.
- To restore: stop the server, copy the backup over `data/<mode>/aquatrack-<mode>.db`, delete any `-wal` and `-shm` files, then start the server.
- Uploaded meter photos are in `data/<mode>/uploads/`. Back up that folder too.

## 7. Security and data integrity

- Passwords are hashed with scrypt and a salt. The minimum is 10 characters with letters and numbers. Accounts lock for 15 minutes after 5 failed sign-ins, and there is also a per-IP-address throttle. Admin password resets force a change at the next sign-in.
- Sessions use a random token in an HttpOnly, SameSite=Strict cookie, stored hashed on the server, with a configurable expiry. Write requests need an anti-CSRF header.
- **Role-based access is enforced on the server for every request.** Customers are scoped to their own account by their login, never by a URL parameter. Meter readers can be limited to one service area.
- Every write endpoint validates its input. Parameterised SQL is used throughout. A strict Content-Security-Policy and other security headers are set. CSV exports are protected against formula injection.
- **Readings:** the original value is immutable, enforced by a database trigger. Corrections are stored separately with the reason and user, and readings cannot be deleted. Billed readings cannot be rejected or corrected without cancelling the bill.
- **Payments:** these are immutable and cannot be deleted (database triggers). Reversals are separate entries, and **the same user cannot reverse their own payment**. A mobile-money or bank reference can be used only once. Card data is refused and never stored.
- **Adjustments** use maker-checker: a different user approves them.
- **Tariffs** that have been used on a bill cannot have their rates changed. Create a new version instead.
- **Two-factor sign-in (TOTP, RFC 6238):** works with any authenticator app, offline, without SMS. Secrets are encrypted at rest with AES-256-GCM using `AQ_SECRET_KEY` (environment) or a key file generated in `data/<mode>/secret.key` — **back this key up separately from the database**, or 2FA users must be reset. Codes cannot be replayed; sign-in challenges expire after 5 minutes and 5 tries; 8 one-time recovery codes are stored hashed. Admins can require 2FA per role (users are sent to set it up before they can do anything else) and reset it for a lost phone, which also signs that user out everywhere. Every user can see and sign out their other devices.
- **Connections:** a manager must give a recorded reason to start an installation before the deposit is paid. Applications can't be cancelled once payments exist on the new account. The public form has a honeypot, a minimum fill time and a limit of 3 per device per day.
- **SMS cost:** by default outgoing SMS are kept in the GSM 7-bit alphabet (accents such as ê, ã, ç and symbols such as — are simplified), so one SMS holds 160 characters instead of 70. Switch this off in Country & languages if your aggregator and customers prefer full accents.
- **Cash closes:** cashiers cannot review their own close, a rejection needs a reason, and after a close is submitted that cashier cannot record more cash for that day and currency until it is reopened. Expected cash excludes reversed receipts.
- **Stock movements** are immutable (database triggers); stock on hand is always the sum of movements. Only stores managers receive or adjust stock, adjustments need a reason, and stock can never go negative.
- **Feedback** requests are one per job per phone, replies are accepted for 7 days, and a later SMS never overwrites an earlier rating.
- **Imports** are checked before anything is written, are all-or-nothing, and are recorded in the audit log.
- **Audit log:** append-only (enforced by triggers) and **hash-chained**. The Audit log page checks the integrity of the chain.
- **Unreliable internet and power:** field readings are saved to the phone's storage (IndexedDB) before anything else, synced in batches with idempotent IDs (re-sending never duplicates), and kept as receipts for 7 days. The app shell is cached by a service worker. The database uses SQLite WAL with daily backups.

## 8. Architecture

```
server/
  index.js                 HTTP(S) server, static files, security headers, daily backup
  lib/                     db (SQLite + tamper triggers), auth (RBAC, sessions), audit (hash chain), validate, csv, http router
  services/                readings (validation flags), billing (tariffs, bills, payments, ledger), alerts (rules engine)
  integrations/index.js    meter-integration layer: adapters, required-info checks, API keys, ingest, verify, simulator
  services/channels.js     USSD menu, SMS keywords, outbound SMS (simulator provider)
  services/momo.js         mobile-money ingest, auto-matching, statement CSV import
  services/waterpoints.js  kiosk sales, water cards, top-ups, reconciliation, handovers
  services/insights.js     water balance, revenue-protection scoring, public aggregate statistics
  services/community.js    no-login reports, tracking, closed-loop SMS, public status, area SMS broadcast
  services/quality.js      water-quality thresholds, tests, alerts and automatic advisories
  services/collections.js  payment plans, reminders, humane escalation ladder
  services/labs.js         tariff & affordability simulation, morning briefing
  services/connections.js  new-connection pipeline, quotes, deposits, financed instalments on bills
  services/shared.js       shared compound connections: bill splitting, household references and credits
  services/kpi.js          cost recovery & IBNET-style performance indicators
  services/onboarding.js   CSV import of customers, meters and opening balances (preview → all-or-nothing commit)
  services/accounts.js     shared customer creation / meter assignment
  lib/totp.js              two-factor codes and secret encryption
  modules/growth.js        REST API for connections, shared compounds, indicators, onboarding
  services/supply.js       supply timetables, heads-up SMS, delivery log, reliability
  services/stock.js        stores: items, immutable movements, materials per work order
  services/fleet.js        meter replacement planner (under-registration estimate, payback)
  services/feedback.js     SMS rating requests, replies, low-score follow-up, summaries
  modules/service.js       REST API for supply, stores, meter planner, feedback
  services/maintenance.js  service plans, run-hours, due work orders, status log and functionality
  services/servicelevels.js SDG 6.1 / JMP service-ladder estimates
  services/cashclose.js    cashier end-of-day close and cash book
  modules/operations.js    REST API for maintenance, service levels and cash close
  lib/i18n.js, i18n/*.json customer-facing SMS/USSD messages per language, keyword aliases, money formatting, languages
  lib/tz.js, lib/countries.js  local time zone handling; country presets
  modules/i18n.js          languages, translation editor, CSV export/import, country presets
public/js/i18n.js          screen translation (phrase dictionary applied to the page as it renders; English fallback)
public/i18n/               catalog.json (every screen phrase) and ui-<lang>.json dictionaries
scripts/i18n-extract.js    rebuilds the phrase catalogue from the source; scripts/i18n-build.js builds dictionaries from scripts/i18n/*.txt
  modules/                 REST API: auth, admin, customers+meters+readings, billing, ops (alerts, work orders, assets), reports, portal
  seed.js                  fictional demo data (demo DB only)
public/                    single-page app (plain ES modules, no build step), service worker, offline store
  js/ocr.js                on-device meter OCR (crop, binarise, wheel-by-wheel reading, multi-pass voting)
  vendor/tesseract/        bundled OCR engine and English model (cached for offline use)
  transparency.html        public / donor page served at /t/<token>
  status.html              public community status & reporting page served at /status
  js/route.js              offline route optimiser (nearest-neighbour + 2-opt)
scripts/                   create-admin.js, test-flows.js, backup-now.js
deploy/                    install.sh (server setup), update.sh (tested updates with rollback), systemd units — see DEPLOY.md
.github/workflows/         automated tests on every push
data/demo | data/live      separate databases, uploads and backups
```

**Reading flags** (for review): estimated, possible duplicate, lower than previous, unusually high, no consumption, future timestamp, long gap, meter not active, device fault / reverse flow / tamper / low battery / leak (device-reported only), unverified integration, simulated, no photo, captured offline, corrected.

**Alert rules** (configurable thresholds): continuous flow / likely leak (interval device data), sudden unusual consumption, no consumption, device-reported reverse flow / tamper / fault, missing or delayed readings, low battery / communication failure (communicating meters only), and bulk supply vs billed consumption gap. Every alert shows its **data basis**: Measured, Manual, Estimated or Simulated.

**Billing:** only *approved* readings are used. The tariff is chosen by most-specific match: customer type → area → meter size → billing mode, effective on the period-end date. Bills include a fixed charge, progressive bands, fixed or percentage fees, a minimum charge and tax. The opening reading is the previous bill's closing reading, so estimated bills reconcile automatically. Accounts with no approved reading are skipped unless you choose "estimate missing", and those bills are marked ESTIMATED. Payments are allocated to a chosen bill first, then to the oldest unpaid bills. Overpayments become credit.

**Water balance** (Water-loss intelligence) follows the IWA structure:

- System input = recorded bulk/district supply.
- Authorised consumption = billed metered + billed estimated + unbilled authorised (an assumed % of input).
- Water losses = input − authorised. These are split into apparent losses (an assumed % meter under-registration plus an assumed % unauthorised use) and real losses (the rest).
- NRW = input − billed.

The data grade is A (measured supply, actual readings), B (some estimates) or C (estimated or simulated supply, or many estimates). Areas without supply data get no NRW figure.

**Revenue-protection scoring** flags zero-consumption streaks, sharp drops against the account's own history, use far below similar accounts, repeated estimates, tamper or reverse-flow events, decreasing readings and faulty meters. Every score lists its reasons, and a high score is a reason to inspect, not proof.

**Public / donor page:** a revocable tokenised link showing aggregates only. Names, account numbers, phones, addresses and individual readings are never included. Counts under 5 are shown as "<5", and requests are rate-limited.

**Community reporting safeguards:** reports need no login. Bots are blocked by a hidden honeypot field and a minimum fill time, and there are limits per device (5 per hour) and per phone (5 per day). Photos are size-limited and visible only to staff. The public page and the tracking result never show names, accounts, bills or reporter phone numbers.

**Humane collections rules:**

- Reminders go 3 days before the due date, then once when 7 days overdue. Each reminder is sent only once, and the timings can be changed in Settings.
- The ladder has five stages: reminder, then personal contact, then offer a plan, then a manager review, and "on plan" while a plan is on track.
- Anyone who has paid in the last 31 days, or owes less than one normal bill, is not escalated to review.
- Essential services (clinics, schools, public water points, or accounts flagged as essential) go to "escalate to management" instead of review.
- A review is only a work order for a manager. It must record the steps already taken, and the system never disconnects anyone.

## 9. Known limitations and next steps

- Connection costs in Settings are entered in USD and converted for LRD areas at the latest recorded rate; the quote can always be edited line by line.
- Shared-compound shares are a fairness and collection aid. The account holder remains legally responsible for the account balance.
- Performance indicators use the system's own data plus what you enter (costs, staff, hours of supply). They are not audited figures. Cost per m³ supplied uses only months with bulk-supply data.
- Service levels cover only people served by the utility's own connections and water points; the rest of the area population is shown as "not served by the utility / unknown", not as unimproved. Collection time is one figure per water point, not per household.
- Functionality is measured from status changes staff record; a breakdown nobody reports is not counted.
- Screen translation works phrase by phrase: sentences assembled from several pieces may read slightly unnaturally, and server error messages are still in English. Dates and numbers follow the language's format.
- Day boundaries for billing periods and reports use UTC dates; supply timetables use the configured time zone.
- Supply times are local clock times in the configured time zone. A window cannot run past midnight; use two schedules. Customers without a zone only get messages for whole-area schedules.
- Water meters are tracked individually in the meter register, not as store items.
- Two-factor sign-in uses authenticator apps only (no SMS codes, which are weaker and cost money).

- Spreadsheet import takes CSV. Save `.xlsx` files as CSV first.
- SMS and USSD run through the built-in simulator until an aggregator is connected (see section 4). No email sending.
- Mobile-money callbacks use a generic format until checked against the providers' real specifications. Statement CSV import works today.
- Photo OCR works best on clear, well-framed photos and does not read the red litre wheels. The person reading always confirms the value.
- Water cards are numbers (printed or phone). There is no NFC/RFID card reader or prepaid tap integration yet.
- The route optimiser orders stops by straight-line distance and hands off to OpenStreetMap for turn-by-turn directions. No offline road map is bundled.
- An attendant's chlorine test needs a connection when it is saved: it is not queued offline the way sales are.
- No basemap tiles in the app. Use GeoJSON export with QGIS or the OpenStreetMap links.
- Telemetry from pressure, flow, level or pump sensors can be stored with `source='sensor'`, but no sensor adapter has been verified yet.
- Single-server deployment. For several offices, host centrally behind HTTPS.
