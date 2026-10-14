# Self-hosting at home, behind a small VPS (frp tunnel)

This guide runs **all of ArcFlow Sentinel on an Ubuntu server inside VMware on your Windows PC**. A small, cheap VPS is the public entry point: it holds the domain and the HTTPS certificate, and passes every request through an encrypted tunnel to your PC. No ports are opened on your home router, because the tunnel is dialled **outwards** from home.

If you want to run everything on one VPS instead, use [Self-hosting on a VPS](self-hosting.md). This guide refers to it for app settings that are the same in both setups.

```
                    Internet
                       │  https://sentinel.example.com (ports 443/80)
                       ▼
┌──────────────── VPS (1 vCPU, 1 GB) ────────────────┐
│ Caddy: HTTPS certificate, security headers         │
│   └─► 127.0.0.1:8080 ─┐                            │
│ frps (port 7000) ◄────┘  tunnel end                │
│   127.0.0.1:2222 ─► SSH to home (admin only)       │
└────────────▲───────────────────────────────────────┘
             │ one outbound TLS connection, token-authenticated,
             │ certificate-pinned, reconnects on its own
┌────────────┴──── Windows PC ── VMware ── Ubuntu VM ─┐
│ frpc ─► 127.0.0.1:3000  web (UI + API)              │
│       ─► 127.0.0.1:22   SSH                         │
│ Docker: postgres · migrate · web · worker           │
│ watchdog: checks the public URL every minute        │
└─────────────────────────────────────────────────────┘
```

**Why this design**

| Choice                                           | Reason                                                                                                                                                                                                                                |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **frp** for the tunnel (tested with v0.71.0)     | Reconnects by itself after drops, restarts and reboots, and carries several ports over one connection. Runs as a small service on each side. A plain-SSH alternative is in the [appendix](#appendix-plain-ssh-tunnel-instead-of-frp). |
| **HTTPS ends on the VPS**                        | The certificate needs ports 80/443 on a public IP, which only the VPS has. Caddy there also sets the real visitor IP, which the app needs for rate limiting.                                                                          |
| **Tunnel ports bound to the VPS's own loopback** | Port 8080 (the site) and 2222 (SSH) are reachable only from the VPS itself: by Caddy, or by you through `ssh -J`. The internet sees only 22, 80, 443 and the token- and TLS-protected tunnel port 7000.                               |
| **The app listens on 127.0.0.1 at home**         | Nothing on the home server is reachable from your LAN or the internet except SSH from the LAN.                                                                                                                                        |

**Trade-offs to accept**

- The site is up only while the PC is on. Part A makes Windows and VMware stay up and restart by themselves.
- Page speed depends on your home **upload** bandwidth (10 Mbit/s or more is comfortable).
- The VPS decrypts HTTPS before tunnelling, so the VPS must be yours and kept secure. The tunnel itself is encrypted again with TLS.

What was tested for this guide:

- The exact frp configs, the TLS certificate pinning and the systemd restart behaviour.
- Reconnect after an frps restart: about 4 s.
- Wrong-token and wrong-certificate rejection.
- Loopback-only ports.
- The VPS maintenance page.
- The home compose override.

---

## Before you start

### What you need

| Item                                                                           | Notes                                                                                                                |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| Windows 10/11 PC that can stay on 24/7                                         | 4+ CPU cores, 16 GB RAM (8 GB go to the VM), 80 GB free disk, preferably SSD.                                        |
| VMware Workstation Pro 17 (free for personal use) or VMware Workstation Player | Pro is recommended, because it includes `vmrun` for automatic start.                                                 |
| An Ubuntu Server 24.04 LTS VM                                                  | A default install is fine; Part B prepares it.                                                                       |
| A VPS                                                                          | The smallest plan works: 1 vCPU, 512 MB–1 GB RAM, 10 GB disk, a **public IPv4** address. Any provider. Ubuntu 24.04. |
| A domain                                                                       | Where you can create DNS records, e.g. `sentinel.example.com`.                                                       |
| Arc and Base mainnet RPC URLs                                                  | As in [self-hosting.md › Stage 0](self-hosting.md#stage-0-prerequisites).                                            |
| An SSH key on your laptop                                                      | `ssh-keygen -t ed25519` if you don't have one.                                                                       |

### Values used in this guide

Replace these everywhere you see them:

| Placeholder            | Meaning                           | Example                 |
| ---------------------- | --------------------------------- | ----------------------- |
| `sentinel.example.com` | Your domain                       | `sentinel.mydomain.com` |
| `VPS_IP`               | The VPS's public IPv4             | `203.0.113.10`          |
| `admin`                | Your user on the VPS              | `admin`                 |
| `sentinel`             | Your user on the home server      | `sentinel`              |
| `HOME_VM_IP`           | The VM's IP on the VMware network | `192.168.152.128`       |

Commands marked **[VPS]**, **[HOME]** (the Ubuntu VM), **[WINDOWS]** (PowerShell as Administrator) or **[LAPTOP]** run on that machine.

---

## Part A: Windows and VMware (keep the server alive)

A server that sleeps, or that doesn't come back after a Windows update, takes the site down. These steps prevent both.

### A1. VM hardware

In VMware, open **VM → Settings** (the VM must be shut down):

| Setting         | Value                                                                                     |
| --------------- | ----------------------------------------------------------------------------------------- |
| Processors      | 4 cores                                                                                   |
| Memory          | 8 GB (6 GB minimum)                                                                       |
| Hard disk       | 60 GB or more                                                                             |
| Network adapter | **NAT**. The tunnel only needs outbound internet, and NAT keeps the VM off your home LAN. |

**Check:** the VM boots, and running `ip -4 addr` inside it shows an address like `192.168.x.x`. That is `HOME_VM_IP`.

### A2. Never sleep

**[WINDOWS]**, PowerShell as Administrator:

```powershell
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg /change monitor-timeout-ac 15
powercfg /hibernate off
```

Also turn off "Allow the computer to turn off this device to save power": open **Device Manager**, then your network adapter, then **Properties → Power Management**.

If your BIOS has an option such as **"Restore on AC power loss: Power On"**, enable it so the PC starts again after a power cut.

### A3. Start the VM automatically at boot

VMware has no reliable built-in autostart for desktop editions, so a scheduled task runs `vmrun` at boot.

1. Find your `.vmx` file, e.g. `D:\VMs\Sentinel\Sentinel.vmx`.
2. Find `vmrun.exe`. It's usually `C:\Program Files (x86)\VMware\VMware Workstation\vmrun.exe`; check it exists.
3. **[WINDOWS]**:

```powershell
$vmrun  = "C:\Program Files (x86)\VMware\VMware Workstation\vmrun.exe"
$vmx    = "D:\VMs\Sentinel\Sentinel.vmx"
$action  = New-ScheduledTaskAction -Execute $vmrun -Argument "-T ws start `"$vmx`" nogui"
$trigger = New-ScheduledTaskTrigger -AtStartup
$trigger.Delay = "PT1M"   # wait one minute for networking and VMware services
$set = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit 0 -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName "Start Sentinel VM" -Action $action -Trigger $trigger -Settings $set -User $env:USERNAME -RunLevel Highest -Password (Read-Host "Your Windows password")
```

Use `-T player` instead of `-T ws` for VMware Workstation Player. A Windows account signed in with a PIN still has a password; enter that.

**Check:** reboot Windows and don't log in. After about 2 minutes, `ssh sentinel@HOME_VM_IP` from another device on your LAN, or from Windows once logged in, connects. Running `vmrun list` in PowerShell shows the VM.

### A4. Shut the VM down cleanly when Windows shuts down (recommended)

The database survives a hard stop, but a clean shutdown is safer.

- **Windows Pro or Enterprise:** run `gpedit.msc`, then go to **Computer Configuration → Windows Settings → Scripts (Startup/Shutdown) → Shutdown → Add**.
  - Script: `C:\Program Files (x86)\VMware\VMware Workstation\vmrun.exe`
  - Parameters: `-T ws stop "D:\VMs\Sentinel\Sentinel.vmx" soft`
- **Windows Home:** there's no shutdown-script editor. Rely on A5 to avoid surprise reboots; Postgres recovers automatically after a hard stop.

### A5. Control Windows Update restarts

Open **Settings → Windows Update → Advanced options**:

- Set **Active hours** to cover your daytime.
- Turn on **"Notify me when a restart is required"**.

Reboot deliberately at a quiet time; thanks to A3 everything comes back by itself.

---

## Part B: The Ubuntu home server

Log in to the VM console in VMware as the user you created during installation.

### B1. Updates, VMware tools, time

**[HOME]**

```sh
sudo apt update && sudo apt -y full-upgrade
sudo apt -y install open-vm-tools unattended-upgrades ca-certificates curl git ufw
sudo dpkg-reconfigure -plow unattended-upgrades      # answer "Yes"
sudo timedatectl set-ntp true && timedatectl         # "System clock synchronized: yes"
```

Accurate time matters: webhook signatures and stage deadlines depend on it.

### B2. Your admin user and SSH key

If your user isn't called `sentinel`, either use your own name throughout or create it:

```sh
sudo adduser sentinel && sudo usermod -aG sudo sentinel
```

**[LAPTOP]** Copy your key to the VM (your laptop must be on the same LAN as the PC; on the PC itself, use Windows' built-in `ssh`):

```sh
ssh-copy-id sentinel@HOME_VM_IP
ssh sentinel@HOME_VM_IP          # must log in without a password
```

Then **[HOME]** allow key login only:

```sh
sudo sed -i -E 's/^#?PasswordAuthentication .*/PasswordAuthentication no/; s/^#?PermitRootLogin .*/PermitRootLogin no/' /etc/ssh/sshd_config
sudo systemctl restart ssh
```

**Check:** from a second terminal, `ssh sentinel@HOME_VM_IP` still works **before** you close the first one.

### B3. Firewall

The tunnel connects outwards, so nothing needs to come in except SSH from your own network:

```sh
sudo ufw default deny incoming && sudo ufw default allow outgoing
sudo ufw allow from 192.168.0.0/16 to any port 22 proto tcp     # adjust if HOME_VM_IP is not 192.168.x.x
sudo ufw --force enable && sudo ufw status
```

The tunnel's SSH access arrives on the loopback interface, which ufw doesn't block, so it works without a rule.

### B4. Docker

**[HOME]**, exactly as in [self-hosting.md › Stage 2](self-hosting.md#stage-2-install-the-container-runtime):

```sh
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt update && sudo apt -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker sentinel
exit    # log out and back in so the docker group applies
```

**Check:** `docker compose version` prints v2.24.4 or newer (`compose.tunnel.yaml` uses the `!override` tag), and `systemctl is-enabled docker` prints `enabled`.

### B5. Get the code and configure the app

```sh
sudo install -d -o sentinel -g sentinel /opt/arcflow-sentinel
git clone <your repository URL> /opt/arcflow-sentinel
cd /opt/arcflow-sentinel
git checkout <release tag or commit>

cp .env.example .env && touch worker.env && chmod 600 .env worker.env
alias dc='docker compose -f compose.yaml -f compose.tunnel.yaml'
echo "alias dc='docker compose -f compose.yaml -f compose.tunnel.yaml'" >> ~/.bashrc
```

Fill in `.env` as described in [self-hosting.md › Stage 5.2](self-hosting.md#52-fill-in-env), with these differences for this setup:

- **`SITE_ADDRESS`: leave it empty.** HTTPS is handled on the VPS.
- **`POSTGRES_PASSWORD`: required.** Set it before the first start: `openssl rand -hex 24`.
- `TRUST_PROXY=true` is already set by `compose.tunnel.yaml`.
- `ANCHOR_PRIVATE_KEY`, if you use anchoring, goes **only** in `worker.env`.

Build the image (the first build takes 3–8 minutes), then create the evidence signing key:

```sh
dc build
dc run --rm --no-deps worker pnpm --filter @sentinel/evidence keygen
```

Paste the printed `EVIDENCE_SIGNING_KEY=…` line into `.env`, and **back it up** somewhere safe outside the VM. Generate `API_KEYS` with `openssl rand -hex 24`.

### B6. Start the app and check it locally

```sh
dc up -d
dc ps                                                  # postgres, web, worker running; migrate exited
curl -s http://127.0.0.1:3000/api/health/ready         # {"status":"ok","checks":{"database":"ok"}}
```

The app is now running, reachable only on the VM itself. The next parts make it public.

---

## Part C: The VPS

### C1. First login and hardening

**[LAPTOP]** `ssh root@VPS_IP` (or the user your provider created), then **[VPS]**:

```sh
apt update && apt -y full-upgrade
apt -y install unattended-upgrades ca-certificates curl ufw openssl
dpkg-reconfigure -plow unattended-upgrades

adduser --disabled-password --gecos "" admin && usermod -aG sudo admin
passwd admin                                           # a password for sudo
install -d -m 700 -o admin -g admin /home/admin/.ssh
cp ~/.ssh/authorized_keys /home/admin/.ssh/ && chown admin: /home/admin/.ssh/authorized_keys

sed -i -E 's/^#?PasswordAuthentication .*/PasswordAuthentication no/; s/^#?PermitRootLogin .*/PermitRootLogin no/' /etc/ssh/sshd_config
systemctl restart ssh
timedatectl set-ntp true
```

**Check:** a new terminal on your laptop can `ssh admin@VPS_IP` and run `sudo -v`. Keep the root session open until it can.

### C2. Firewall

**[VPS]**

```sh
sudo ufw default deny incoming && sudo ufw default allow outgoing
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw allow 443/udp   # website (HTTP, HTTPS, HTTP/3)
sudo ufw allow 7000/tcp                                                     # frp tunnel from home
sudo ufw --force enable && sudo ufw status
```

If your provider also has a cloud firewall or security group, open the same ports there: 22, 80, 443 (TCP and UDP) and 7000.

### C3. DNS

At your DNS provider, create an **A record**: `sentinel.example.com → VPS_IP`. If your DNS provider offers a "proxy" or CDN mode (for example Cloudflare's orange cloud), keep it **off** for now; Caddy needs to reach Let's Encrypt directly.

**Check (from your laptop):** `nslookup sentinel.example.com` returns `VPS_IP`. DNS can take a few minutes.

---

## Part D: The frp tunnel

### D1. Install frp on both machines

Run on the **VPS** and on **HOME**, so each side gets the binary it needs:

```sh
FRP_VERSION=0.71.0
ARCH=$(dpkg --print-architecture)          # amd64 or arm64
cd /tmp
curl -fLO https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/frp_${FRP_VERSION}_linux_${ARCH}.tar.gz
curl -fLO https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/frp_sha256_checksums.txt
grep "  frp_${FRP_VERSION}_linux_${ARCH}.tar.gz" frp_sha256_checksums.txt | sha256sum -c -   # must print: OK
tar xzf frp_${FRP_VERSION}_linux_${ARCH}.tar.gz

sudo useradd --system --no-create-home --shell /usr/sbin/nologin frp
sudo install -d -m 750 -o root -g frp /etc/frp /etc/frp/tls
```

Then, on the **VPS** only:

```sh
sudo install -m 755 /tmp/frp_${FRP_VERSION}_linux_${ARCH}/frps /usr/local/bin/frps && frps --version
```

And on **HOME** only:

```sh
sudo install -m 755 /tmp/frp_${FRP_VERSION}_linux_${ARCH}/frpc /usr/local/bin/frpc && frpc --version
```

### D2. Create the shared token and the tunnel certificate

All of this runs on the **VPS**.

- **The token** is a shared password: only a frpc that knows it may connect.
- **The certificate** lets the home side verify it is really talking to _your_ VPS, and not to an impostor in between.

```sh
mkdir -p ~/frp-setup && cd ~/frp-setup && umask 077
openssl rand -hex 32 > token

# A private certificate authority, and a server certificate signed by it (valid 10 years)
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 3650 \
  -subj "/CN=sentinel-frp-ca" -keyout ca.key -out ca.crt
openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
  -subj "/CN=frps.internal" -keyout server.key -out server.csr
printf "subjectAltName=DNS:frps.internal\n" > server.ext
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 3650 \
  -extfile server.ext -out server.crt
openssl verify -CAfile ca.crt server.crt       # must print: server.crt: OK

sudo install -m 640 -o root -g frp token      /etc/frp/token
sudo install -m 640 -o root -g frp server.crt /etc/frp/tls/server.crt
sudo install -m 640 -o root -g frp server.key /etc/frp/tls/server.key
```

`frps.internal` is just a name inside the certificate. It doesn't need DNS.

Copy the token and the CA certificate to the home server. **[HOME]**:

```sh
scp admin@VPS_IP:frp-setup/token admin@VPS_IP:frp-setup/ca.crt /tmp/
sudo install -m 640 -o root -g frp /tmp/token  /etc/frp/token
sudo install -m 640 -o root -g frp /tmp/ca.crt /etc/frp/tls/ca.crt
rm /tmp/token /tmp/ca.crt
```

`scp` from home to the VPS uses your VPS SSH key. If the VM doesn't have it, copy the two files via your laptop instead.

Then **[VPS]** keep `ca.key` somewhere offline, because it's only needed to issue a new server certificate, and remove the working copies:

```sh
cd ~ && rm -f frp-setup/token frp-setup/server.* frp-setup/ca.srl
# download ~/frp-setup/ca.key and ca.crt to a safe place, then: rm -rf ~/frp-setup
```

### D3. Configure and start frps (VPS)

**[VPS]** Create the config. This is the same as `deploy/tunnel/frps.toml` in the repository:

```sh
sudo tee /etc/frp/frps.toml > /dev/null <<'EOF'
bindAddr = "0.0.0.0"
bindPort = 7000

# Tunnelled ports listen on the VPS loopback only (Caddy uses 8080, you use 2222 via ssh -J).
proxyBindAddr = "127.0.0.1"
allowPorts = [ { single = 8080 }, { single = 2222 } ]
maxPortsPerClient = 2

auth.method = "token"
auth.tokenSource.type = "file"
auth.tokenSource.file.path = "/etc/frp/token"

transport.tls.force = true
transport.tls.certFile = "/etc/frp/tls/server.crt"
transport.tls.keyFile = "/etc/frp/tls/server.key"

log.level = "info"
detailedErrorsToClient = false
EOF
sudo chown root:frp /etc/frp/frps.toml && sudo chmod 640 /etc/frp/frps.toml
```

Create the service. This is the same as `deploy/tunnel/frps.service`:

```sh
sudo tee /etc/systemd/system/frps.service > /dev/null <<'EOF'
[Unit]
Description=frp server (ArcFlow Sentinel tunnel)
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
User=frp
Group=frp
ExecStart=/usr/local/bin/frps -c /etc/frp/frps.toml
Restart=always
RestartSec=5
LimitNOFILE=65536
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadOnlyPaths=/etc/frp

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload && sudo systemctl enable --now frps
systemctl status frps --no-pager | head -5         # active (running)
journalctl -u frps -n 5 --no-pager                 # "frps started successfully"
```

### D4. Configure and start frpc (home)

**[HOME]** The repository already contains the config and the service:

```sh
cd /opt/arcflow-sentinel
sudo install -m 640 -o root -g frp deploy/tunnel/frpc.toml /etc/frp/frpc.toml
sudo sed -i 's/VPS_PUBLIC_IP/VPS_IP/' /etc/frp/frpc.toml        # put your real VPS IP here
sudo cp deploy/tunnel/frpc.service /etc/systemd/system/frpc.service
sudo systemctl daemon-reload && sudo systemctl enable --now frpc
journalctl -u frpc -n 10 --no-pager
```

What the logs should show:

- **frpc:** `login to server success` and `start proxy success` for `sentinel-web` and `sentinel-ssh`.
- **frps** (`journalctl -u frps -n 10` on the VPS): `client login info` and `new proxy [sentinel-web] … success`.

**Check [VPS]:**

```sh
curl -s http://127.0.0.1:8080/api/health/ready     # {"status":"ok",...}, served from your PC
sudo ss -ltnp | grep -E ':(7000|8080|2222) '       # 7000 on 0.0.0.0; 8080 and 2222 on 127.0.0.1 only
```

---

## Part E: HTTPS on the VPS (Caddy)

### E1. Install Caddy

**[VPS]**, from Caddy's official package repository:

```sh
sudo apt -y install debian-keyring debian-archive-keyring apt-transport-https gnupg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt -y install caddy
```

### E2. Configure the site

Copy `deploy/tunnel/Caddyfile.vps` from the repository to `/etc/caddy/Caddyfile` on the VPS, and replace `sentinel.example.com` with your domain. From the home server:

```sh
scp /opt/arcflow-sentinel/deploy/tunnel/Caddyfile.vps admin@VPS_IP:/tmp/Caddyfile
```

**[VPS]**

```sh
sudo sed -i 's/sentinel.example.com/YOUR_DOMAIN/' /tmp/Caddyfile
sudo install -m 644 /tmp/Caddyfile /etc/caddy/Caddyfile

sudo install -d -o caddy -g caddy -m 750 /var/log/caddy
sudo touch /var/log/caddy/sentinel.log
sudo chown caddy:caddy /var/log/caddy/sentinel.log
sudo chmod 640 /var/log/caddy/sentinel.log

sudo caddy validate --config /etc/caddy/Caddyfile        # "Valid configuration"
sudo systemctl reload caddy
journalctl -u caddy -n 20 --no-pager | grep -iE 'certificate|error'
```

Within a minute Caddy logs `certificate obtained successfully`. That configuration:

- forwards to the tunnel;
- adds HSTS and other security headers;
- shows a friendly "Back in a moment" page (HTTP 503, `Retry-After: 60`) whenever the home server is unreachable.

**Check [LAPTOP]:**

```sh
D=https://sentinel.example.com
curl -sI $D | head -1                          # HTTP/2 200
curl -s  $D/api/health/ready                   # {"status":"ok",...}
curl -s  $D/api/health/routes                  # chains and Iris reachable
```

Open the site in a browser and trace the example transfer from the README. Your app, running at home, is now public.

---

## Part F: Admin SSH to the home server from anywhere

The tunnel also carries SSH. It's bound to the VPS's loopback, so you go through the VPS as a jump host.

**[LAPTOP]** Add to `~/.ssh/config` (on Windows: `C:\Users\<you>\.ssh\config`):

```
Host sentinel-vps
  HostName VPS_IP
  User admin

Host sentinel-home
  HostName 127.0.0.1
  Port 2222
  User sentinel
  ProxyJump sentinel-vps
  HostKeyAlias sentinel-home
  ServerAliveInterval 30
```

Now `ssh sentinel-home` opens a shell on your PC's VM from anywhere. Copying files works too, e.g. `scp backup.sql.gz sentinel-home:`. Both hops use key login only (B2, C1).

---

## Part G: Make it run for weeks without attention

### G1. What restarts what

| Failure                             | What recovers it                                                                                                       | Typical time                      |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| Internet drop at home or on the VPS | frpc retries forever (`loginFailExit = false`), and systemd restarts it if it exits                                    | seconds after the network returns |
| frps restarts or the VPS reboots    | systemd starts frps at boot; frpc reconnects by itself                                                                 | about 5 s (tested)                |
| frpc crashes                        | systemd `Restart=always`, never giving up (`StartLimitIntervalSec=0`)                                                  | 5 s                               |
| A container crashes                 | Docker `restart: unless-stopped`                                                                                       | seconds                           |
| The app hangs but the tunnel is up  | frpc's health check withdraws the site so visitors see the maintenance page; the watchdog (G2) restarts the containers | 30 s to 3 min                     |
| A stuck tunnel nobody noticed       | The watchdog checks the public URL every minute and restarts frpc after 3 failures                                     | about 3 min                       |
| Windows reboots                     | The scheduled task starts the VM (A3), and everything inside starts at boot                                            | 2–3 min                           |

### G2. Install the watchdog (home)

**[HOME]**

```sh
cd /opt/arcflow-sentinel
sudo tee /etc/default/sentinel-watchdog > /dev/null <<'EOF'
SENTINEL_PUBLIC_URL=https://sentinel.example.com
SENTINEL_APP_DIR=/opt/arcflow-sentinel
EOF
sudo cp deploy/tunnel/tunnel-watchdog.service deploy/tunnel/tunnel-watchdog.timer /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now tunnel-watchdog.timer
systemctl list-timers tunnel-watchdog.timer --no-pager      # next run within a minute
journalctl -u tunnel-watchdog -n 5 --no-pager               # quiet while everything is healthy
```

### G3. Keep logs from filling the disk (both machines)

```sh
sudo sed -i -E 's/^#?SystemMaxUse=.*/SystemMaxUse=500M/' /etc/systemd/journald.conf
sudo systemctl restart systemd-journald
```

Container logs are already capped by `compose.tunnel.yaml` (5 × 20 MB per container). Caddy's site log rotates at 20 MB, keeping 5 files.

### G4. External uptime check

Add a free monitor (UptimeRobot, Better Stack, …) on `https://sentinel.example.com/api/health/ready`, checking every 1–5 minutes and emailing you on failure. It's the only check that sees the full path, so it'll notice even if everything else thinks it's fine.

### G5. The 7-day check

After a week, these commands tell you how the setup behaved:

**[VPS]**

```sh
systemctl show frps -p ActiveEnterTimestamp -p NRestarts         # NRestarts=0 is ideal
journalctl -u frps --since "-7d" --no-pager | grep -c "client login info"   # how often home reconnected
```

**[HOME]**

```sh
systemctl show frpc -p ActiveEnterTimestamp -p NRestarts
journalctl -u tunnel-watchdog --since "-7d" --no-pager | grep -c "failed"   # watchdog interventions
dc ps                                                             # all containers Up for days
```

A handful of reconnects is normal (home internet blips, router restarts). Investigate if:

- the uptime monitor shows less than 99 %;
- there are dozens of watchdog interventions;
- `NRestarts` keeps growing.

---

## Part H: Day-to-day operation

| Task                          | How                                                                                                                                                                                                                                                                                                       |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Logs                          | **[HOME]** `dc logs -f --tail 100 web worker` · **[VPS]** `journalctl -u frps -f`, `sudo tail -f /var/log/caddy/sentinel.log`                                                                                                                                                                             |
| Upgrade the app               | **[HOME]** back up first, then `git fetch && git checkout <tag> && dc build && dc up -d`. Visitors see the maintenance page for a few seconds.                                                                                                                                                            |
| Upgrade frp                   | Install the new `frps` and `frpc` binaries as in D1 (same version on both sides), then `sudo systemctl restart frps` / `frpc`. Read the frp release notes first.                                                                                                                                          |
| Upgrade Caddy and the OS      | Unattended-upgrades handles security patches; `sudo apt upgrade` for the rest. Kernel updates need a reboot. Everything comes back by itself.                                                                                                                                                             |
| Backups                       | **[HOME]** follow [self-hosting.md › Stage 9](self-hosting.md#stage-9-backups) with `COMPOSE="docker compose -f compose.yaml -f compose.tunnel.yaml"`. Keep a copy off the VM, e.g. `scp sentinel-home:/var/backups/arcflow-sentinel/*.gz .` from your laptop, or a VMware shared folder on another disk. |
| Anchoring, webhooks           | As in [self-hosting.md Stages 7–8](self-hosting.md#stage-7-enable-anchoring-optional), using `dc` from this guide.                                                                                                                                                                                        |
| Rotate the tunnel token       | Generate a new one (D2), install it on both sides, then restart frps and frpc.                                                                                                                                                                                                                            |
| Rotate the tunnel certificate | Reissue `server.crt` with the saved `ca.key` (D2), install it on the VPS, then `sudo systemctl restart frps`.                                                                                                                                                                                             |
| VPS IP changed                | Update the DNS A record and `serverAddr` in `/etc/frp/frpc.toml`, then `sudo systemctl restart frpc`.                                                                                                                                                                                                     |

---

## Troubleshooting

| Symptom                                       | Where to look, and the fix                                                                                                                                                                                   |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Site shows "Back in a moment"                 | The home side isn't reachable. **[VPS]** `curl -s 127.0.0.1:8080/api/health/live`. Then **[HOME]** `systemctl status frpc`, `dc ps`, `curl 127.0.0.1:3000/api/health/live`. Is the PC on and the VM running? |
| frpc logs `tls: failed to verify certificate` | `/etc/frp/tls/ca.crt` at home doesn't match the VPS's certificate: copy `ca.crt` again (D2).                                                                                                                 |
| frpc logs `register control error` or `token` | The tokens differ: copy `/etc/frp/token` again, and check the file has no extra spaces or lines.                                                                                                             |
| frpc logs `i/o timeout` connecting to the VPS | Port 7000 is blocked: check `ufw status` on the VPS **and** the provider's cloud firewall. Check `serverAddr` is the right IP.                                                                               |
| frps logs `port not allowed`                  | A proxy uses a port missing from `allowPorts`. The configs here use only 8080 and 2222.                                                                                                                      |
| Caddy: certificate not obtained               | DNS doesn't point to `VPS_IP` yet, ports 80/443 are closed, or a DNS proxy/CDN mode is on. Caddy retries on its own; watch `journalctl -u caddy -f`.                                                         |
| Everything is down after a Windows reboot     | The scheduled task didn't start the VM: open **Task Scheduler → Start Sentinel VM → History**. Check the `vmrun.exe` and `.vmx` paths, and that the task runs "whether user is logged on or not".            |
| VM clock is wrong after the PC slept          | Sleep should be off (A2). `timedatectl` should show synchronized; `sudo systemctl restart systemd-timesyncd`.                                                                                                |
| `429 Too many new traces` for everyone        | Rate limits can't tell clients apart. Check that requests come through Caddy, and that `compose.tunnel.yaml` is used (`TRUST_PROXY=true`).                                                                   |
| `ssh sentinel-home` fails                     | `ssh sentinel-vps` must work first. On the VPS, `ss -ltn                                                                                                                                                     | grep 2222`must show the tunnel. If you hardened the VPS's sshd,`AllowTcpForwarding`must not be`no`. |

---

## Security summary

- **Public on the VPS:** 22 (key-only SSH), 80/443 (Caddy) and 7000 (frp, TLS only and token-protected).
- **Loopback only on the VPS:** the tunnel ports 8080 and 2222.
- **Home server:** nothing is published. The app is on 127.0.0.1, and SSH is open to the LAN only (plus via the tunnel).
- **Tunnel security:** the home side verifies the VPS against the pinned CA, and the VPS rejects clients without the token. Both checks were tested.
- **Secret files and where they live:**

  | Secret                 | Location             | Access             |
  | ---------------------- | -------------------- | ------------------ |
  | Tunnel token, TLS keys | `/etc/frp`           | root:frp, mode 640 |
  | App secrets            | `.env`, `worker.env` | mode 600           |
  | `ca.key`               | offline              |                    |

- **Plaintext on the VPS:** the VPS sees decrypted HTTPS traffic, so treat it as part of your trusted infrastructure.

---

## Appendix: plain SSH tunnel instead of frp

If you'd rather use plain OpenSSH, `autossh` can hold a reverse tunnel open. It's fine, but recovery after a stale connection is slower: up to about 45 s while the server notices the old session is dead, versus frp's few seconds. frp is the tested default for this guide.

**[VPS]** Create a tunnel-only user that may open exactly those two loopback ports and nothing else:

```sh
sudo adduser --disabled-password --gecos "" tunnel
sudo install -d -m 700 -o tunnel -g tunnel /home/tunnel/.ssh
# Add one line to /home/tunnel/.ssh/authorized_keys (the key comes from the home server, below):
#   restrict,port-forwarding,permitlisten="127.0.0.1:8080",permitlisten="127.0.0.1:2222" ssh-ed25519 AAAA… sentinel-tunnel
printf 'ClientAliveInterval 15\nClientAliveCountMax 3\n' | sudo tee /etc/ssh/sshd_config.d/tunnel.conf
sudo systemctl restart ssh
```

**[HOME]**

```sh
sudo apt -y install autossh
sudo install -d -m 700 /etc/sentinel-tunnel
sudo ssh-keygen -t ed25519 -N "" -C sentinel-tunnel -f /etc/sentinel-tunnel/id_ed25519
sudo cat /etc/sentinel-tunnel/id_ed25519.pub     # paste into the VPS line above
sudo ssh-keyscan VPS_IP | sudo tee /etc/sentinel-tunnel/known_hosts

sudo tee /etc/systemd/system/sentinel-ssh-tunnel.service > /dev/null <<'EOF'
[Unit]
Description=Reverse SSH tunnel to the VPS (ArcFlow Sentinel)
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Environment=AUTOSSH_GATETIME=0
ExecStart=/usr/bin/autossh -M 0 -N \
  -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes \
  -o UserKnownHostsFile=/etc/sentinel-tunnel/known_hosts -o StrictHostKeyChecking=yes \
  -i /etc/sentinel-tunnel/id_ed25519 \
  -R 127.0.0.1:8080:127.0.0.1:3000 -R 127.0.0.1:2222:127.0.0.1:22 \
  tunnel@VPS_IP
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload && sudo systemctl enable --now sentinel-ssh-tunnel
```

Everything else stays the same: Caddy (Part E), the jump host (Part F) and the watchdog. In the watchdog, replace `systemctl restart frpc` with `systemctl restart sentinel-ssh-tunnel`. Skip Part D, and on the VPS run `sudo ufw delete allow 7000/tcp`.
