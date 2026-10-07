# ADR-010: CPU multilingual embedding baseline

Date: 7 October 2026. Status: candidate only; no model or revision selected; G3 pending.

## Context

Full vector retrieval needs an embedding runtime available without requiring a particular GPU vendor. English/Czech is the proposed initial corpus scope. Model and tokenizer revisions, license, query/document preprocessing, dimensions, memory and cache footprint affect index identity and compatibility.

## Decision

Require a CPU execution baseline. Evaluate `intfloat/multilingual-e5-small` as the light candidate and `BAAI/bge-m3` as an optional advanced candidate. Evaluate `BAAI/bge-reranker-v2-m3` only as an optional independently measured reranker. None is frozen, installed or supported by this decision. Pin immutable model and tokenizer revisions after license review; preserve model-specific prefixes/preprocessing in the index fingerprint. Do not enable arbitrary remote model code as a fallback.

## Consequences and limits

Portable CPU support can be measured across Windows and macOS without a mandatory CUDA/ROCm backend. Quality, binary wheels, resource fit, license compatibility, download identity and Apple Silicon behavior remain unverified. The multilingual-e5 model card documents `query:` and `passage:` prefixes; implementation must verify the exact selected revision and test them ([model card](https://huggingface.co/intfloat/multilingual-e5-small)). Candidate names alone do not create a compatibility lock.

## Required G3 evidence

Immutable revision/license record, isolated CPU lock, finite/dimension checks, preprocessing fixtures, matched English/Czech BM25/vector/hybrid benchmark, cold/warm latency and memory/disk observations, and Windows plus macOS receipts before cross-platform support is claimed.
