---
name: competitor-review
description: >-
  Review existing competitor claims and their supporting material for entity attribution, chronology, contradictions,
  and coverage gaps. Use for evidence review of supplied claims or the review phase of a competitor investigation.
  Do not use to start a fresh collection workflow, create unsupported findings, write a general research brief,
  or perform unrelated code review.
---

# Competitor Evidence Review

Assess whether the supplied claims are supported at their stated scope. Review does not create missing evidence.

## Read the material

Read [the evidence checklist](references/checklist.md) before reviewing claims. In Cwatch, use `session__read_skill_resource` with `skill=competitor-review` and `path=references/checklist.md`; otherwise use the available read-only file or document tool.

Identify the claims, referenced sources, entity and product scope, and applicable time window. If essential evidence is missing, state the limitation and ask for or retrieve only the material necessary for the requested review.

## Review each claim

- Check that the source actually supports the named entity, product, and assertion.
- Check the relevant event or publication time separately from retrieval time.
- Preserve contradictory evidence, uncertain identity matches, source failures, and missing coverage.
- Distinguish supported facts, interpretations, and unsupported statements. Do not invent identifiers, dates, or results to fill a gap.

## Return the assessment

For each material issue, identify the affected claim, the supporting or conflicting reference, and the correction or additional evidence needed. Finish with the conclusions that remain supported and the unresolved gaps.

When running inside an active investigation, preserve its existing plan, collection, analysis, review, and draft prerequisites. For a standalone review of supplied material, do not start that workflow unless the user requests it. This Skill does not grant tools, execute scripts, or change host permissions.
