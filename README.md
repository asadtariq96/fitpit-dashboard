# FitPit Lane Rental Dashboard

Live dashboard for private swim lane availability at **Kilo** (Espoo) and **Valkea talo** (Haaga), powered by FitPit's booking API.

**Live:** https://fitpit.asad.dev

## Quick start (local)

```bash
git clone https://github.com/asadtariq96/fitpit-dashboard.git
cd fitpit-dashboard
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn api.main:app --reload --host 127.0.0.1 --port 8766
```

Open [http://127.0.0.1:8766](http://127.0.0.1:8766)

## Deploy (VPS)

```bash
git clone https://github.com/asadtariq96/fitpit-dashboard.git ~/projects/fitpit-dashboard
cd ~/projects/fitpit-dashboard
chmod +x deploy.sh
mkdir -p ~/.config/systemd/user
cp fitpit-dashboard.service ~/.config/systemd/user/
./deploy.sh
```

Updates:

```bash
cd ~/projects/fitpit-dashboard
git pull
./deploy.sh
```

Caddy snippet (`/etc/caddy/Caddyfile`):

```
fitpit.asad.dev {
	reverse_proxy localhost:3003
}
```

## Features

- Live availability from FitPit `apieventgroups` API (same as the website)
- Calendar grid with green/red slot cards
- Filter by location, days ahead (7–60), available-only
- Auto-refresh every 5 minutes

## API

| Endpoint | Description |
|----------|-------------|
| `GET /api/availability?days=15` | Full availability data |
| `GET /api/locations` | Location metadata |
| `GET /api/health` | Health check |
