# Putting AquaTrack online with Cloudflare

AquaTrack runs on **one small always-on server** that you control, where its database, photos and backups stay on a
real disk. **Cloudflare Tunnel** puts that server on your own domain with HTTPS and DDoS protection, and you open
no ports on the server or the office router. **GitHub** holds the code: every new version pushed there is tested on
the server, backed up and installed automatically within about 10 minutes.

```
 Phones & browsers ──HTTPS──▶ Cloudflare (your domain) ──Tunnel──▶ cloudflared ─▶ AquaTrack 127.0.0.1:8080 ─▶ /var/lib/aquatrack
                                                                     (same server; nothing listens publicly)
 GitHub (private repo) ◀── the server checks for a new commit every 10 minutes (read-only deploy key)
```

Why not Cloudflare Workers or Containers? Workers have no disk for the SQLite database. Cloudflare Containers wipe
their disk when they go to sleep, so the database would be lost. Moving to D1/R2 would mean rewriting the data layer.

## What you need

| | |
|---|---|
| A server | Ubuntu 22.04/24.04 or Debian 12, 1–2 GB RAM, 20 GB disk. A small VPS (about US$5–6/month), or a mini-PC or Raspberry Pi 4/5 with a UPS at the utility office. It only needs outgoing internet. |
| A domain on Cloudflare | The free plan is enough. The domain's DNS must be managed by Cloudflare. |
| A GitHub account | A **private** repository for the code. |

## 1. Put the code on GitHub (once)

The zip you received is a git repository (it contains the `.git` folder).

1. On GitHub create a new **private** repository, for example `aquatrack`, with no README.
2. On your computer, in the unzipped `aquatrack` folder:
   ```bash
   git remote add origin git@github.com:YOUR-ACCOUNT/aquatrack.git
   git push -u origin main
   ```
   (Or use GitHub Desktop: *File › Add local repository*, then *Publish repository* and keep it private.)
3. GitHub runs the automated tests on every push (*Actions* tab). They should show green.

## 2. Prepare Cloudflare (about 5 minutes)

**First check the domain.** The address is `ya.ciu.edu.lr`. A tunnel can only publish a hostname whose domain's DNS
is managed by Cloudflare in the same account, so `ciu.edu.lr` must appear under **Websites** (Domains) in the
Cloudflare account you use, with status *Active*. If it does not:
- **Recommended:** ask whoever manages `ciu.edu.lr` (CIU's IT office) to add the domain to Cloudflare (Free plan) and
  change its nameservers at the `.lr` registry to the two Cloudflare nameservers shown. Cloudflare copies the
  existing DNS records; IT should check that email (MX), the university website and any other records came across
  before switching. Then make sure your account can manage the zone.
- A plain CNAME at another DNS provider pointing `ya` at the tunnel does not work. Delegating only the `ya`
  subdomain to Cloudflare needs an Enterprise plan, and CNAME (partial) setup needs a Business plan.
- If the nameservers cannot move: run AquaTrack without the tunnel. Give the server a public IP, have IT add an
  `A` record `ya.ciu.edu.lr → <server IP>`, and put Caddy in front for automatic HTTPS (README › Going live), with
  `TRUST_PROXY=1`. Updates from GitHub work the same way.

1. In the Cloudflare dashboard go to **Networking › Tunnels** (Zero Trust) and choose **Create a tunnel**. Name it
   `aquatrack` and choose **Linux**.
2. Copy the **token** from the `sudo cloudflared service install …` command it shows (the long text after `install`).
   Keep it secret.
3. Open the tunnel and go to **Routes › Add route › Published application**. For **Subdomain** enter `ya`, for
   **Domain** choose `ciu.edu.lr` (giving `ya.ciu.edu.lr`). For **Service**, choose HTTP and enter `127.0.0.1:8080`.
   Cloudflare creates the DNS record itself.
4. Recommended: protect sensitive paths with **Cloudflare Access**. A demo site should be fully private; for a live
   site you can protect `/` for staff and leave the public paths open (`/status`, `/t/*`, `/api/public-*`,
   `/api/gateway/*`, `/api/ingest/*`, `/api/i18n/*`).

## 3. Set up the server (once, about 10 minutes)

Copy `deploy/install.sh` and the files next to it to the server (or `git clone` your repository there), then run:

```bash
sudo bash deploy/install.sh --repo git@github.com:YOUR-ACCOUNT/aquatrack.git --tunnel-token PASTE-THE-TOKEN
```

The installer:
- Installs Node.js 22, cloudflared, git and unzip.
- Creates the `aquatrack` user, with the code in `/opt/aquatrack` and the data in `/var/lib/aquatrack`.
- Writes `/etc/aquatrack/aquatrack.env`. This includes a new random `AQ_SECRET_KEY`: **copy this file somewhere safe**.
- Makes a **read-only deploy key**, prints it and waits while you add it on GitHub (*repository › Settings › Deploy keys › Add deploy key*, write access off).
- Installs the first version. The automated tests run first, so this takes about a minute.
- Starts AquaTrack on `127.0.0.1:8080`, turns on automatic updates and connects the tunnel.

Then create the first administrator (the command is printed at the end), open `https://ya.ciu.edu.lr`,
sign in, and in **Administration › Country & languages** set your country, currencies and languages.

To run a **demo** copy instead, add `--demo`. It loads the fictional demo data, whose accounts share a published
password, so keep it behind Cloudflare Access.

## 4. Updating from now on

Push to `main` on GitHub. Within about 10 minutes the server:

1. Sees the new commit and downloads it.
2. Runs the automated tests on the new code, using a throwaway demo database. **If any test fails, nothing changes**, and that commit is skipped.
3. Backs up the live database (`/var/lib/aquatrack/live/backups/…-pre-update-<commit>.db`).
4. Switches to the new version, restarts and checks `/api/health`. **If the new version does not come up healthy within 30 seconds, the previous version is put back automatically.**
5. Keeps the last 5 versions in `/opt/aquatrack/releases`.

Useful commands on the server:

```bash
journalctl -t aquatrack-update -n 50          # what the updater did
journalctl -u aquatrack -f                     # AquaTrack's own log
sudo aquatrack-update                          # check for a new version now (normally the timer does this)
sudo aquatrack-update --rollback               # go back to the previous version (pauses automatic updates until a newer commit is pushed)
sudo aquatrack-update --zip aquatrack.zip      # install from a zip instead of GitHub
systemctl status aquatrack cloudflared
```

(`aquatrack-update` is installed in `/opt/aquatrack/bin/` and linked from `/usr/local/bin/`.)

Database changes are applied automatically when a new version starts. They only ever add tables and columns, and
the pre-update backup is there if you need to restore (see README › Backups and restore).

## Settings in `/etc/aquatrack/aquatrack.env`

| Setting | Meaning |
|---|---|
| `APP_MODE=live` | Live database (`demo` for the demo). |
| `HOST=127.0.0.1`, `PORT=8080` | Listen only on the server itself; the tunnel connects locally. |
| `TRUST_PROXY=cloudflare` | Read the visitor's real IP from Cloudflare's `CF-Connecting-IP`, only for requests arriving locally from cloudflared. This keeps sign-in throttling and public-form limits working. |
| `COOKIE_SECURE=1` | Session cookies are sent over HTTPS only. |
| `AQ_SECRET_KEY` | Encrypts two-factor secrets. Back it up; if it is lost, every user's 2FA must be reset. |
| `REPO_URL`, `BRANCH` | Where updates come from. |

After editing this file, run `sudo systemctl restart aquatrack`.

## Backups off the server

The app keeps daily backups in `/var/lib/aquatrack/live/backups` (how many is set in Settings). Copy them off the
machine regularly as well, for example with a nightly `rclone` to Cloudflare R2 or Google Drive. Keep a copy of
`/etc/aquatrack/aquatrack.env` in the same place.
