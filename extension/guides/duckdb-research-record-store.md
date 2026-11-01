# DuckDB record store

Planned persistent source/claim/evidence storage.

## Setup

No persistent store, database file, owning worker or migration recipe is implemented by the extension. Consult current official docs for independent experiments.

## First task and readiness

Future setup requires single-owner writing, backups/restores and schema migration contracts before research records are durable. The current lexical prototype does not use this store.

## Troubleshooting and limits

Planned and Not bundled describe integration status. Diagnostics does not inspect databases or infer readiness from a generic DuckDB installation. Persistence and recovery require their own validation.

## Current documentation

[Current official documentation](https://duckdb.org/docs/stable/). Local onboarding reviewed on 11 October 2026. The bundled guide is a release snapshot; the official link opens the maintained source and may describe a newer version than your lock.

[Back to guide hub](index.md)
