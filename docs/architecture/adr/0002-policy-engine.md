# ADR 0002 — Policy Engine gates every side-effect
**Status:** accepted
**Decision:** No agent touches the outside world until `PolicyEngine.evaluate()` approves.
Rules live as data (risk caps, spend approvals, QA/coverage gates), not scattered ifs.
**Why:** agents stay autonomous but auditable — the requirement for scaling an AI workforce
without losing control. This is the "last piece" that makes POLIS enterprise-grade.
