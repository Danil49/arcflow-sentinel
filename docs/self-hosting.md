# Self-hosting on a VPS

This guide takes a fresh VPS to a production ArcFlow Sentinel at `https://<your-domain>`. It covers automatic HTTPS, backups and monitoring. Follow the stages in order; each ends with a check.

To run the app on a home server (e.g. an Ubuntu VM in VMware) with only a small VPS as the public proxy, follow [Self-hosting at home behind a VPS](self-hosting-ssh.md) instead.

Everything runs in containers from this repository:

```
Internet ──443/80──► caddy (TLS, security headers) ──► web :3000 (UI + API)
                                                         │
                         worker (traces, webhooks, anchoring) ──► Arc / Base RPC, Circle Iris
                                                         │
                                      postgres (volume) ◄┘    migrate (runs once per start)
```

| File                | Role                                                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `compose.yaml`      | Base stack: Postgres, migrate, web, worker. Good for local use.                                                                                   |
| `compose.prod.yaml` | Production overrides: Caddy with Let's Encrypt, the app off public ports, the anchor key visible to the worker only, log rotation, memory limits. |
| `deploy/Caddyfile`  | Reverse proxy config (HTTPS, HSTS, security headers).                                                                                             |
| `deploy/backup.sh`  | Nightly `pg_dump` with retention.                                                                                                                 |

On the server, always run compose with both files. The commands below use this alias:

```sh
alias dc='docker compose -f compose.yaml -f compose.prod.yaml'
```

---

## Stage 0: Prerequisites

| You need                          | Notes                                                                                                                                                         |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A VPS                             | Sizing below. Ubuntu 24.04 LTS or Debian 12, x86_64 or arm64.                                                                                                 |
| A domain or subdomain             | For example `sentinel.example.com`. You must be able to create DNS A/AAAA records.                                                                            |
| Arc and Base **mainnet** RPC URLs | With archive state (historical `eth_call`). Alchemy's free tier works; see "RPC limits" below. Add an Arc **testnet** RPC only if you want testnet anchoring. |
| Outbound internet from the VPS    | To the RPC providers, `iris-api.circle.com`, Let's Encrypt, and (during builds) `registry.npmjs.org` and `docker.io`.                                         |
| Optional: an anchor account       | A dedicated key with a little USDC on Arc mainnet. About 0.0005 USDC per anchor; 2 USDC covers thousands.                                                     |

### VPS sizing

|         | Minimum                 | Recommended |
| ------- | ----------------------- | ----------- |
| vCPU    | 2                       | 2–4         |
| RAM     | 2 GB **plus 4 GB swap** | 4 GB        |
| Disk    | 25 GB SSD               | 40 GB SSD   |
| Network | IPv4 (IPv6 optional)    |             |

Building the image on the server needs about 2 GB of RAM: `next build` is the peak. At runtime the stack uses roughly 600–900 MB. The image is about 1.1 GB, and Docker keeps old layers until you prune them.

Memory limits set in `compose.prod.yaml`: web 1 GB, worker 768 MB, Postgres 1 GB, Caddy 256 MB. Raise them on bigger servers.

---

## Stage 1: Prepare and harden the server

Run as root (or with sudo) on the new VPS.

```sh
# 1. Updates and automatic security patches
apt update && apt -y full-upgrade
apt -y install unattended-upgrades ca-certificates curl git ufw
dpkg-reconfigure -plow unattended-upgrades

# 2. A non-root admin user with your SSH key
adduser --disabled-password --gecos "" sentinel
usermod -aG sudo sentinel
install -d -m 700 -o sentinel -g sentinel /home/sentinel/.ssh
cp ~/.ssh/authorized_keys /home/sentinel/.ssh/ && chown sentinel: /home/sentinel/.ssh/authorized_keys

# 3. SSH: keys only, no root login
sed -i -E 's/^#?PasswordAuthentication .*/PasswordAuthentication no/; s/^#?PermitRootLogin .*/PermitRootLogin no/' /etc/ssh/sshd_config
systemctl restart ssh

# 4. Firewall: SSH, HTTP, HTTPS (TCP + UDP for HTTP/3)
ufw default deny incoming && ufw default allow outgoing
ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443/tcp && ufw allow 443/udp
ufw --force enable

# 5. Swap (required with 2 GB RAM; harmless with more)
fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab

# 6. Time sync (chain timestamps and webhook signatures depend on it)
timedatectl set-ntp true && timedatectl
```

Docker publishes ports by writing its own iptables rules, which **bypass ufw**. That's why only Caddy publishes ports (80 and 443) in `compose.prod.yaml`. Postgres and the app are never published. Don't add `ports:` to them.

**Check:** you can SSH in as `sentinel`, `ufw status` shows only 22, 80 and 443, and `swapon --show` lists the swap file.

---

## Stage 2: Install the container runtime

Use **Docker Engine** with the compose plugin, from Docker's official repository. Ubuntu shown; for Debian, replace `ubuntu` with `debian` in the URLs.

```sh
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt update && sudo apt -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker sentinel   # log out and back in afterwards
```

To use Podman (5.x) instead, use `podman compose` wherever this guide says `docker compose`. The stack was tested with both. Rootless Podman can't bind ports 80 and 443 unless you set `net.ipv4.ip_unprivileged_port_start=80`.

**Check:** `docker compose version` prints v2.24 or newer. The `!reset` tag in `compose.prod.yaml` needs at least that version.

---

## Stage 3: DNS

Create an `A` record (and an `AAAA` record if the VPS has IPv6) for your domain, pointing at the VPS IP. Caddy can obtain a certificate only once this resolves and ports 80/443 are reachable from the internet.

**Check:** `dig +short sentinel.example.com` returns the VPS IP.

---

## Stage 4: Get the code

```sh
sudo install -d -o sentinel -g sentinel /opt/arcflow-sentinel
git clone <your repository URL> /opt/arcflow-sentinel
cd /opt/arcflow-sentinel
git checkout <release tag or commit>    # deploy a known version, not a moving branch
```

For a private repository, use a read-only deploy key (`ssh-keygen -t ed25519 -f ~/.ssh/sentinel_deploy`, added as a deploy key on the repository).

---

## Stage 5: Configure

### 5.1 Create the env files

Secrets are split across two files so the web container never sees the anchor key:

| File         | Read by                                     | Contains                                                                 |
| ------------ | ------------------------------------------- | ------------------------------------------------------------------------ |
| `.env`       | every container, plus compose interpolation | RPCs, database password, domain, signing key, API keys, webhooks, limits |
| `worker.env` | worker only                                 | `ANCHOR_PRIVATE_KEY`                                                     |

```sh
cp .env.example .env
touch worker.env
chmod 600 .env worker.env
```

Both files are git-ignored and excluded from the image build context.

### 5.2 Fill in `.env`

Blank lines like `NAME=` are treated as unset, so you only need to fill in what you use.

**Required**

| Variable                      | Value                                                                                                                                                                                           |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SITE_ADDRESS`                | Your domain, e.g. `sentinel.example.com` (no scheme). Caddy uses it to obtain the certificate.                                                                                                  |
| `POSTGRES_PASSWORD`           | A strong random value (`openssl rand -hex 24`). **Set it before the first start**: Postgres stores it on first initialization, and changing it later means changing it inside the database too. |
| `ARC_RPC_URL`, `BASE_RPC_URL` | Mainnet RPC URLs.                                                                                                                                                                               |
| `CCTP_NETWORK`                | `mainnet`                                                                                                                                                                                       |
| `EVIDENCE_SIGNING_KEY`        | Generated in 5.3.                                                                                                                                                                               |
| `API_KEYS`                    | One or more `openssl rand -hex 24` values, comma-separated. They protect confirm, anchor and webhook-test, and allow `requireAppConfirmation`.                                                  |

`DATABASE_URL` is set by compose and points at the bundled Postgres; leave it blank. `TRUST_PROXY=true` is set by `compose.prod.yaml`, because Caddy rewrites `X-Forwarded-For` with the real client address.

**Recommended**

| Variable                                              | Value                                                                            |
| ----------------------------------------------------- | -------------------------------------------------------------------------------- |
| `ARC_LOG_CHUNK_SIZE`, `BASE_LOG_CHUNK_SIZE`           | `10` on Alchemy's free tier. Only needed with `COLLECT`.                         |
| `RATE_LIMIT_TRACES_PER_MINUTE` / `_GLOBAL_PER_MINUTE` | Defaults are 10 and 60 new traces a minute. Lower them if RPC credits are tight. |

**Optional**

| Variable                                                                                                      | Purpose                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `COLLECT=arc,base`                                                                                            | Passively tail CCTP contracts. About 21k `getLogs` calls a day at a 10-block span; leave empty to trace on demand only. |
| `WEBHOOK_URLS`, `WEBHOOK_SECRET`                                                                              | Push every status change to your systems (Stage 8).                                                                     |
| `STAGE_DEADLINES_JSON`                                                                                        | Override when a stage counts as stuck, in minutes, e.g. `{"mint":180}`.                                                 |
| `ANCHOR_NETWORK`, `ANCHOR_MODE`, `ANCHOR_SUBMITTER_ADDRESS`, `ANCHOR_MAX_FEE_USDC`, `ANCHOR_MIN_BALANCE_USDC` | Anchoring (Stage 7).                                                                                                    |

### 5.3 Build the image and generate the signing key

The server needs no Node.js; tools run inside the image.

```sh
alias dc='docker compose -f compose.yaml -f compose.prod.yaml'
dc build                                                          # ~2–5 min the first time
dc run --rm --no-deps worker pnpm --filter @sentinel/evidence keygen
```

Copy the printed `EVIDENCE_SIGNING_KEY=…` line into `.env`, and keep the printed public key. This key signs every evidence bundle, so **back it up somewhere safe**. If you lose it, you can no longer produce bundles verifiable against the same published key. If it leaks, anyone can forge bundles in your name.

**Check:** `grep -c . .env` shows your values are there, and `ls -l .env worker.env` shows `-rw-------`.

---

## Stage 6: First start

```sh
dc up -d
dc ps
```

The start order is automatic: Postgres becomes healthy, `migrate` applies the migrations and exits 0, then web and the worker start, and Caddy starts once web is healthy.

Expected `dc ps`: `postgres`, `web`, `worker` and `caddy` running (web `healthy`), and `migrate` exited.

Optionally, load two recorded historical transfers as labelled demo data. This is offline and safe to re-run:

```sh
dc exec worker pnpm --filter @sentinel/worker exec tsx scripts/seed-demo.ts
```

### Verify the deployment

Run these from **your laptop**, not the server:

```sh
D=https://sentinel.example.com
curl -sI $D | head -1                                   # HTTP/2 200
curl -s  $D/api/health/ready                            # {"status":"ok","checks":{"database":"ok"}}
curl -s  $D/api/health/routes                           # status "ok": both chains and Iris reachable
curl -s  $D/.well-known/sentinel-key.json               # your public key (matches keygen output)
curl -s  -X POST $D/api/traces -H 'content-type: application/json' \
  -d '{"sourceTxHash":"0xf2b45ee11be4e44ba04a9b5cb0aee99c1cb7a0b4bca42814bd146feb198c5432","sourceChain":"arc"}'
```

Then open the site. The traced transfer (41,300.343736 USDC, Arc to Base) should reach "Minted" within seconds. Download its evidence and verify it from your laptop, from a clone of the repo:

```sh
curl -OJ "$D/api/traces/<id>/evidence?download=1"
npx pnpm@10.18.3 --filter @sentinel/evidence verify-evidence sentinel-evidence-*.json --key-url $D/.well-known/sentinel-key.json
```

**Check:** all of the above succeed, and https://www.ssllabs.com/ssltest/ grades the domain A or A+.

---

## Stage 7: Enable anchoring (optional)

Anchoring writes each evidence hash to the `EvidenceRegistry` on Arc. It is already deployed on Arc mainnet at `0xD37a99DC7a7CA2E3b1A75648886875E50a6b52FF`, so you don't need to deploy anything.

1. Use a **dedicated** account that holds only a little USDC on Arc mainnet (USDC is Arc's gas token). Never use your main wallet: the key lives on the server.
2. Put the key **only** in `worker.env`:
   ```sh
   echo 'ANCHOR_PRIVATE_KEY=0x…' > worker.env && chmod 600 worker.env
   ```
3. Add to `.env`:
   ```
   ANCHOR_NETWORK=mainnet
   ANCHOR_MODE=manual          # or "terminal" to also anchor automatically when a trace completes
   ```
4. Restart the worker and check it:
   ```sh
   dc up -d worker
   dc exec worker pnpm --filter @sentinel/worker anchor-status
   ```
   This prints the account address, its balance and the caps. Set `ANCHOR_SUBMITTER_ADDRESS=<that address>` in `.env`, then run `dc up -d web`. Verifiers use it to reject anchors submitted by anyone else.
5. Anchor a trace and verify it on chain:
   ```sh
   curl -X POST $D/api/traces/<id>/anchor -H "authorization: Bearer <one of API_KEYS>"
   # The trace page shows "Anchored on Arc mainnet in block …" within seconds. Then:
   npx pnpm@10.18.3 --filter @sentinel/evidence verify-evidence <bundle.json> \
     --key-url $D/.well-known/sentinel-key.json --anchor-tx <anchor tx hash>
   ```

Safety rails:

- The worker refuses an anchor whose worst-case fee exceeds `ANCHOR_MAX_FEE_USDC` (default 0.05).
- It stops anchoring below `ANCHOR_MIN_BALANCE_USDC` (default 0.5).
- It only ever calls the registry, and never sends value.

To deploy your own registry instead, for example on a fork, run `dc run --rm --no-deps worker pnpm --filter @sentinel/contracts deploy --network mainnet`. It uses the key from `worker.env`, and it's a dry run until you add `--yes`. It prints the new address: set `EVIDENCE_REGISTRY_ADDRESS` to it, because the `deployments/` file it writes stays inside the throwaway container.

---

## Stage 8: Webhooks (optional)

1. In `.env`, set `WEBHOOK_URLS=https://your-app.example.com/hooks/sentinel` (comma-separate several) and `WEBHOOK_SECRET=$(openssl rand -hex 32)`. Then run `dc up -d web worker`.
2. Send a signed test event: `curl -X POST $D/api/webhooks/test -H "authorization: Bearer <API key>"`.
3. Your receiver must:
   - verify `x-sentinel-signature` (`v1=HMAC-SHA256(secret, "${x-sentinel-timestamp}.${rawBody}")`);
   - reject timestamps older than 5 minutes;
   - ignore events whose `x-sentinel-sequence` isn't newer than the last one it processed for that trace.

   `verifyWebhook` in `apps/worker/src/webhooks.ts` is the reference implementation.

4. Failed deliveries are retried with backoff and marked dead after 10 attempts: `select url, last_status_code, last_error from webhook_deliveries where status = 'dead';`.

---

## Stage 9: Backups

The database is the only state; everything else can be rebuilt from git. Back up the database and, separately, the secrets (`.env`, `worker.env`, and above all `EVIDENCE_SIGNING_KEY`).

```sh
sudo install -d -o sentinel -g sentinel -m 700 /var/backups/arcflow-sentinel
./deploy/backup.sh /var/backups/arcflow-sentinel 14     # run once by hand
crontab -e                                              # add the nightly job:
# 17 2 * * * cd /opt/arcflow-sentinel && ./deploy/backup.sh /var/backups/arcflow-sentinel 14 >> /var/log/arcflow-backup.log 2>&1
```

Copy the backups off the server, to object storage, another host, or your laptop (e.g. `rclone` or `rsync` from cron). A backup that lives only on the VPS is lost with the VPS.

**Restore** (tested):

```sh
dc stop web worker
gunzip -c /var/backups/arcflow-sentinel/sentinel-<stamp>.sql.gz | dc exec -T postgres psql -U sentinel -d sentinel -v ON_ERROR_STOP=1
dc up -d
```

Practise a restore into a scratch database once:

```sh
dc exec -T postgres createdb -U sentinel restore_check
gunzip -c <file> | dc exec -T postgres psql -q -U sentinel -d restore_check
```

---

## Stage 10: Monitoring

| What                      | How                                                                                                         | Alert when                                 |
| ------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| Site up                   | External uptime check (UptimeRobot, Better Stack, …) on `https://<domain>/api/health/ready`                 | Not 200 for 2+ minutes                     |
| Chains and Iris reachable | The same check on `/api/health/routes` (cached 15 s)                                                        | 503 for 10+ minutes                        |
| Anchor balance            | Cron: `dc exec -T worker pnpm --filter @sentinel/worker anchor-status` (exits 1 when low)                   | Exit code ≠ 0                              |
| Dead jobs                 | `dc exec -T postgres psql -U sentinel -tAc "select count(*) from jobs where status='dead'"`                 | > 0                                        |
| Disk                      | `df -h /` and `docker system df`                                                                            | > 80 %                                     |
| Logs                      | `dc logs -f --tail 100 worker web caddy` (JSON lines, secrets redacted, rotated at 5 × 20 MB per container) | Repeated `job failed` or `collector error` |

---

## Stage 11: Upgrades and rollback

```sh
cd /opt/arcflow-sentinel
./deploy/backup.sh /var/backups/arcflow-sentinel 14     # always back up first: migrations are forward-only
git fetch && git checkout <new tag>
dc build && dc up -d                                    # migrate runs before web and worker start
dc ps && curl -s https://<domain>/api/health/ready
docker image prune -f                                   # reclaim old layers
```

**Rollback:** check out the previous tag and run `dc build && dc up -d`. If the new version ran a migration, the old code may not understand the new schema; restore the pre-upgrade backup (Stage 9) before starting the old version.

During `dc up` the web container is recreated, so expect a few seconds of 502 from Caddy. Schedule upgrades accordingly.

---

## Stage 12: Rotating secrets

| Secret                 | How                                                                                                                                                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `API_KEYS`             | Add the new key next to the old one (comma-separated), run `dc up -d web`, move clients over, then remove the old key.                                                                                                    |
| `WEBHOOK_SECRET`       | Coordinate with receivers: they should accept both secrets during the switch, because there is a single active secret.                                                                                                    |
| `EVIDENCE_SIGNING_KEY` | Bundles signed with the old key stay verifiable only with the old public key. Publish the old public key alongside the new one (e.g. on your docs page) before switching.                                                 |
| `ANCHOR_PRIVATE_KEY`   | Move the remaining USDC to a new dedicated account, update `worker.env` and `ANCHOR_SUBMITTER_ADDRESS`, then `dc up -d web worker`. Old anchors stay valid; verifiers check the submitter that was published at the time. |
| `POSTGRES_PASSWORD`    | `dc exec postgres psql -U sentinel -c "alter user sentinel password '<new>'"`, update `.env`, then `dc up -d`.                                                                                                            |
| RPC URLs               | Update `.env`, then `dc up -d web worker`.                                                                                                                                                                                |

---

## Troubleshooting

| Symptom                                                    | Cause and fix                                                                                                                                                  |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Caddy logs `obtaining certificate … failed`                | DNS doesn't point at the server yet, or ports 80/443 are blocked (check `ufw`, and the cloud provider's firewall or security group). Caddy retries on its own. |
| `dc ps` shows web `unhealthy`, and Caddy never starts      | `dc logs web`. Usually `invalid environment: <VAR>`: fix that variable in `.env`. The message names the variable, never its value.                             |
| Build dies or the server freezes during `dc build`         | Out of memory: add swap (Stage 1) or build on a bigger machine.                                                                                                |
| `429 Too many new traces`                                  | Anonymous creation hit the rate limit. Use an API key, or raise `RATE_LIMIT_TRACES_*`.                                                                         |
| Traces stuck at "Burned" with RPC errors in the worker log | RPC quota or range limits. Set `*_LOG_CHUNK_SIZE=10` on Alchemy's free tier, and check the provider dashboard.                                                 |
| `anchor-status` prints `disabled`                          | Missing `ANCHOR_PRIVATE_KEY` in `worker.env`, `ANCHOR_MODE=off`, or no registry for `ANCHOR_NETWORK`.                                                          |
| Anchor job fails with `AnchorPolicyError`                  | The fee cap was hit (Arc base fee spike) or the balance is low. Fund the account, or wait and the job retries.                                                 |
| `migrate` exits non-zero                                   | `dc logs migrate`. Restore the pre-upgrade backup if a migration failed halfway.                                                                               |

---

## Not covered: decide for your environment

These stages are deliberately left to you, because they depend on your infrastructure:

- **CI/CD auto-deploy:** this guide deploys by hand from a tag. To automate, build and push the image from CI to a registry, then `dc pull && dc up -d` on the server.
- **Offsite backup storage:** `backup.sh` writes locally; pick the destination and tool (rclone, restic, your provider's snapshots).
- **Alerting:** the monitoring table lists what to watch; wire it into your paging or chat tool.
- **Secret management:** the env files are mode 600 on a single host. For teams, use a secret manager (Vault, SOPS, your cloud's secret store) and render `.env` and `worker.env` at deploy time.
- **High availability:** this is a single-node setup. The app is safe to scale horizontally: jobs use `SKIP LOCKED`, anchoring holds an advisory lock, and rate limits live in Postgres. Postgres itself would need a managed service or replication.
- **CDN or WAF in front of Caddy:** recommended for a high-traffic public deployment. Read endpoints aren't rate limited. If you add a proxy in front, configure Caddy's `trusted_proxies` for it, so client IPs stay correct.
