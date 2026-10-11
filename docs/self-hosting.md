# Self-hosting

ArcFlow Sentinel runs as one container image with three roles:

- `migrate`: one-shot database migrations
- `web`: UI and API on port 3000
- `worker`: trace jobs, webhooks, anchoring, and the optional collectors

Postgres is the only other service. `compose.yaml` wires them together and works with Podman or Docker.

## Run

```sh
cp .env.example .env
# Required: ARC_RPC_URL, BASE_RPC_URL, EVIDENCE_SIGNING_KEY, API_KEYS
# Optional: TESTNET_ARC_RPC_URL + ANCHOR_PRIVATE_KEY + ANCHOR_SUBMITTER_ADDRESS (anchoring),
#           WEBHOOK_URLS + WEBHOOK_SECRET, COLLECT, rate limits, STAGE_DEADLINES_JSON
podman compose up -d --build        # or: docker compose up -d --build
open http://localhost:3000
```

- `DATABASE_URL` is set by compose and points at the bundled Postgres; any value in `.env` is ignored.
- Set `POSTGRES_PASSWORD` in your shell or a compose `.env` to change the database password, and `WEB_PORT` to change the published port.

Load the two recorded historical transfers as labelled demo data:

```sh
podman compose exec worker pnpm --filter @sentinel/worker exec tsx scripts/seed-demo.ts
```

## Operate

| Task                                | Command                                                                                                                             |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Status and health                   | `podman compose ps`, `curl localhost:3000/api/health/ready`, `curl localhost:3000/api/health/routes`                                |
| Logs (JSON lines, secrets redacted) | `podman compose logs -f worker web`                                                                                                 |
| Upgrade                             | `git pull && podman compose up -d --build` (migrations run first, automatically)                                                    |
| Scale the worker                    | `podman compose up -d --scale worker=2`. Jobs are claimed with `SKIP LOCKED` and anchoring holds an advisory lock, so this is safe. |
| Back up                             | `podman compose exec postgres pg_dump -U sentinel sentinel > backup.sql`                                                            |
| Dead jobs                           | `select type, last_error from jobs where status = 'dead'` (errors are redacted)                                                     |

## Production notes

- **TLS and proxy:** put a TLS-terminating reverse proxy in front of `web`. If it sets `X-Forwarded-For`, set `TRUST_PROXY=true` so rate limits apply per client.
- **Secrets:** keep them in a secret manager. Never bake them into images; `.env` is excluded from the build context.
- **Anchor account:** fund it minimally. The worker refuses anchors above `ANCHOR_MAX_FEE_USDC` and stops below `ANCHOR_MIN_BALANCE_USDC`.
- **Mainnet anchoring:** deploy the registry with `pnpm --filter @sentinel/contracts deploy --network mainnet --yes`, then set `ANCHOR_NETWORK=mainnet`.
- **Hosted platforms** (Vercel for `web`; Railway, Fly or Render for `worker` and Postgres) work with the same environment variables. They need accounts of their own and aren't required.
