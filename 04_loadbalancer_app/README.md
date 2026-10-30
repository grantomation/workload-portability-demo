# Faux Application Load Balancer

A zero-dependency Node.js app that acts as both a visual control plane and a
switchable Layer 7 reverse proxy for infrastructure migration demos.

One process, one container. On OpenShift, Routes handle TLS termination and
routing — the app just runs behind them. For local/podman use, the legacy
deploy playbooks still work (see `deploy/`).

## Quick Start (local dev)

```bash
node server.js
# Dashboard at http://localhost:8080/
```

The reverse proxy (data plane) activates only when the incoming `Host` header
matches `config.domain`. On localhost this never matches, so you always see the
dashboard.

## OpenShift Deployment

The Tekton pipeline builds and pushes this image automatically. Two Routes serve
the pod:

| Route | Purpose |
|-------|---------|
| `dashboard.<domain>` | Control plane — dashboard UI, API, SSE |
| `<domain>` | Data plane — reverse proxies to the active backend |

Both point at the same Service on port 8080. The app inspects the Host header
to decide whether to serve the dashboard or proxy.

## Podman Deployment (legacy)

```bash
podman build -t localhost/faux-lb:latest .
./hosts.sh add
ansible-playbook deploy/deploy_podman.yml
```

> **Note:** The deploy playbooks in `deploy/` still reference the old
> nginx + Node.js container layout. They need updating for the current
> pure-Node.js container. TLS certs that were previously terminated by nginx
> would need to be handled by a reverse proxy in front, or by adding optional
> TLS support to the Node.js server.

## Configuration

Edit `configmap.yaml` (or `config.yaml` for local dev):

```yaml
title: Application LB
initialActive: 1
domain: portable-workload.example.com

nodes:
  - name: Legacy VM
    position: 1
    icon: vm                  # vm | cloud | baremetal
    url: http://backend.legacy.local

  - name: "Cloud\nManaged Cluster"
    position: 2
    icon: cloud
    url: https://backend.cloud.example.com
```

The file is watched — saving it pushes a live update to every connected
dashboard (no restart needed).

## API Reference

| Endpoint | Method | Description |
|---|---|---|
| `/` | GET | Dashboard UI |
| `/api/state` | GET | JSON: current state (`title`, `nodes`, `active`, `health`) |
| `/api/events` | GET | SSE stream (live updates) |
| `/api/activate` | POST | Switch node: `{"position": 2}` or `{"name": "..."}` |
| `/api/activate?position=2` | GET | Switch node (browser-friendly) |
| `/api/reload` | GET | Re-read config.yaml on demand |
| `/go` | GET | Iframe the currently-active backend |

## Integration with Ansible

```yaml
- name: Switch load balancer to new target
  ansible.builtin.uri:
    url: "http://{{ lb_host }}:8080/api/activate"
    method: POST
    body_format: json
    body:
      position: 2
```

Or use the trigger script:

```bash
./trigger.sh 2 http://<lb-host>:8080
```

## Container Image

Built on `registry.access.redhat.com/hi/nodejs:22` — a Red Hat Hardened Image
(distroless, non-root, near-zero CVEs). No nginx, no shell, no package manager.

## Tests

```bash
node test/harness.js
```

Zero-dependency smoke test that boots the server and exercises all API endpoints.
