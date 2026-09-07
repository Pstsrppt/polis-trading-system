# ADR 0001 — Monorepo with apps/ + packages/ + divisions/
**Status:** accepted
**Decision:** One repo. `packages/` holds OS primitives, `apps/` holds deployables,
`divisions/` holds business domains. Dependency direction is one-way: apps → divisions → packages.
**Why:** lets us add a division (Legal, Customer Support, E-commerce) as a folder with
zero changes elsewhere, while keeping the kernel small and reusable.
**Consequence:** shared versioning via uv workspace; CI builds everything together.
