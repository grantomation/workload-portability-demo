# Load Balancer

## Overview

The load balancer (`04_loadbalancer_app/`) is a visual reverse proxy that gives the demo audience one stable URL. As the workload migrates between clusters, the presenter switches the active backend and the audience sees the transition happen live on a full-screen dashboard.

## Architecture

A single Node.js process, zero npm dependencies. No Nginx -- the server handles both the control plane (dashboard) and data plane (reverse proxy) on one port (8080) using Host header routing:

- Requests where `Host` matches `config.domain` (and does not start with `dashboard.`) are proxied to the active backend
- All other requests (dashboard subdomain, localhost, direct IP) get the dashboard/API

The container image uses `registry.access.redhat.com/hi/nodejs:22` (Red Hat Hardened Image -- distroless, non-root, no shell).

### Why no Nginx

The project originally used Nginx + Node.js in one container. The current design replaced Nginx entirely -- Node.js handles both the dashboard HTTP server and the reverse proxy using `http.request`/`https.request`. This eliminated a process, simplified the container, and removed the need for config file rewrites and reload signals.

### Why zero dependencies

The `package.json` has no `dependencies` at all. The server includes a hand-rolled YAML parser supporting only the flat schema used by `config.yaml`. This avoids needing any `npm install` step, which matters for the distroless container image (no shell, no package manager).

## Dashboard

Full-viewport SVG scene with a "network operations center" aesthetic (dark theme, light theme toggle). Shows:

- A central "APPLICATION LB" orb with the configured domain
- Backend nodes in a pyramid layout, each with an icon (vm, cloud, baremetal)
- Animated Bezier connections -- the active connection shows green flowing particles
- Switching animation: old connection retracts (orange), new connection extends (blue), settles to green after 1300ms

### Real-time updates via SSE

The dashboard opens an EventSource to `/api/events`. Three event types:

- `config` -- full state push (on connect, on config file change)
- `activate` -- backend switch
- `health` -- per-node health status change

Health checks ping each backend every 5 seconds (HTTP GET, 3.5s timeout, `rejectUnauthorized: false` for self-signed certs). Status >= 500, connection failure, or timeout marks a node "offline" with a pulsing red border.

### Standalone mode

The HTML file works when opened directly from disk (no server). Detects this by trying `fetch("/api/state")` -- if it fails, falls back to an embedded config. Useful for offline demos or screenshots.

## API

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/state` | GET | Current state: title, domain, nodes, active position, health |
| `/api/events` | GET | SSE stream |
| `/api/activate` | POST | Switch backend. Body: `{"position": N}` or `{"name": "..."}` |
| `/api/activate?position=N` | GET | Same via query params |
| `/api/reload` | GET | Re-read config.yaml, broadcast to all SSE clients |
| `/go` | GET | HTML page with iframe pointing at the active backend |
| `/go?position=N` | GET | Iframe a specific backend |

The `/go` endpoint is what the audience sees -- a stable vanity URL in the browser address bar, with the actual cluster content rendered via iframe.

## Configuration

- `config.yaml` -- local dev config (dummy targets on localhost)
- `configmap.yaml` -- deployment example. The dashboard pipeline generates environment-specific backend configuration from registered clusters.

Config is watched with `fs.watch()` -- editing it live-reloads all connected dashboards without a restart.

Nodes support multiline names (`\n` in the name field renders as separate lines in the SVG).

## Deployment

### On OpenShift (production)

Built by the `dash-build-deploy-lb` Tekton pipeline (defined in `01_installation_dashboard/pipelines/tekton/pipeline-dash-loadbalancer.yml`). Two Routes serve the same pod on port 8080:

- `dashboard.<domain>` for the control plane
- `<domain>` for the data plane (reverse proxy)

Routes handle TLS termination.

### On a laptop

Run from `04_loadbalancer_app/`. The retained Podman/Ansible playbooks describe
the older container layout and need updating before use with the current image.
For a local preview, run `node server.js`. The historical deployment commands are:

```text
podman build -t localhost/faux-lb:latest .
./hosts.sh add                            # map vanity domain to localhost
ansible-playbook deploy/deploy_podman.yml  # deploys via podman play kube
```

`hosts.sh` reads the domain from `config.yaml` and manages `/etc/hosts` entries. For `portable-workload.example.com`, it creates entries for both the domain and `dashboard.<domain>`.

### Switching backends

Run these commands from `04_loadbalancer_app/`.

```bash
./trigger.sh 2                              # switch to position 2
./trigger.sh 3 http://laptop:8080           # explicit LB URL
GLB_URL=http://lb:8080 ./trigger.sh 4       # via env var
```

`trigger.sh` is a minimal curl wrapper for `POST /api/activate`. Returns non-zero on HTTP errors for Ansible integration.

## Testing

`test/harness.js` is a zero-dependency smoke test that spawns the server, verifies state, switching (by position and name), `/go` iframe, SSE events, and error handling. `test/dummy-targets.js` provides 4 fake backend pages for the test config.
