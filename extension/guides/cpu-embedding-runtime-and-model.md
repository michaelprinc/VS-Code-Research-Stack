# Embedding runtime and model

A separate embedding runtime and model are still not implemented in the toolkit: none is selected, bundled, downloaded or offered as a component step. What 0.3.14 does ship is a dependency-free CPU vector backend inside the record store itself, which needs no runtime of its own and is documented here so the two are not confused.

The store's backend (`src/research_stack/vectors.py`) encodes each stored chunk as a 256-dimensional signed feature-hash signature — backend `rsk-hashing-v1`, tokenizer `unicode-word-v1`, words plus 3- and 4-character n-grams, L2-normalised, quantised to int16, stored base64 in the same SQLite file as the chunks. It imports only the Python standard library, opens no socket and adds no dependency. It is a **lexical signature, not a semantic model**: it ranks on different evidence than BM25 — character n-grams reach inflected variants a word match misses — and nothing in the toolkit treats a cosine value as a truth claim. `embed_corpus` builds it, `index_corpus` writes it for the chunks it stores, and `store_status` states the index as `not-built`, `partial`, `stale` or `ready`. See [corpus index](research-corpus-index.md).

## Setup

Nothing to install and nothing to choose for the shipped backend. A learned model has nothing to install here either: no runtime or immutable model revision is selected/bundled. Catalog candidates are ideas, not installed models. Review model-specific resources, documentation and licensing before choosing an external experiment.

## First task and readiness

There is no toolkit onboarding action yet. A future integration must pair each immutable model with its matching index and retain an old working pair during updates.

## Troubleshooting and limits

Diagnostics never scans caches, loads models or downloads weights. Generic upstream runtime docs are a starting point; a selected model needs its own guide. Unrelated model caches do not establish readiness.

## Current documentation

[Current official documentation](https://huggingface.co/docs/transformers/index). Local onboarding reviewed on 11 October 2026. The bundled guide is a release snapshot; the official link opens the maintained source and may describe a newer version than your lock.

[Back to guide hub](index.md)
