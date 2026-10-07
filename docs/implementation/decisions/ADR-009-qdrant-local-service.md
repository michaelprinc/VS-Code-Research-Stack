# ADR-009: Qdrant local service route for Windows Full

Date: 7 October 2026. Status: candidate decision; no service proof; G3 pending.

## Context

Full needs a persistent vector index. Basic and Research do not require Docker. The proposed Windows route is a locally owned Qdrant Linux container, isolated from any remote service and backed by persistent storage.

## Decision

Retain Qdrant in a pinned local container as the Windows reference candidate. The later installer must discover the active Docker backend and existing resources without modifying them, preview prerequisites and permissions, use a toolkit-owned named volume, bind services to loopback, capture the immutable image digest and validate upsert/search/restart persistence. A port conflict is reported and resolved through an explicit alternate setting; unrelated containers/listeners are never stopped. Remote Qdrant and Qdrant client local mode require independent deployment records.

## Consequences and limits

This provides an explicit service boundary and persistent volume contract but introduces Docker/WSL2, storage and lifecycle dependencies. Qdrant's official Windows quickstart notes named volumes may be required, and installation guidance warns of Windows/WSL bind-mount file-system issues ([quickstart](https://qdrant.tech/documentation/quickstart/), [installation](https://qdrant.tech/documentation/install/)). On 7 October 2026 Docker CLI client/server returned 29.7.2 on the reference host, but no service answered at `127.0.0.1:6333`; no container, volume, image or persistence behavior was validated. This ADR does not authorize or report a service installation.

## Required G3 evidence

Record selected engine/context, existing container and volume inventory, image digest, client/server versions, exact ports/mounts, health, create/upsert/search, container and host restart persistence, and restore-from-snapshot into a separate namespace.
