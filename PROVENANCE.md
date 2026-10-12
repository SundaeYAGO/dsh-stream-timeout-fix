# Provenance

This project is a **vibe-coding product**: its investigation, code and documentation
were produced with **GLM 5.3** (Zhipu AI) and **DeepSeek V4.1 Flash** as the driving
models.

Copyright (c) 2026 SundaeYAGO and the dsh-stream-timeout-fix authors.
Licensed under the MIT License — see [LICENSE](LICENSE).

> This note lives outside `LICENSE` on purpose: extra prose between the copyright
> line and the MIT body stops GitHub's license detection from recognising the file,
> which would label the repository "Other" instead of "MIT".

## What it means in practice

* **Check the claims yourself.** Everything asserted in the README is backed by
  scripts in this repository — `npm test` (5 deterministic tests) and
  `scripts/reproduce-300s.mjs` (the full ~304 s reproduction). Run them instead of
  trusting prose.
* **Review before installing.** The plugin is ~120 lines and deliberately boring,
  but it changes a *process-global* network setting, so read it first.
* **Know the validation limits.** The fix is proven by controlled local
  reproduction plus the test suite; it has **not** yet been exercised by a real
  300+ s stall in production. See "Validation status" in the README.
