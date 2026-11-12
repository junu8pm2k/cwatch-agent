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
- Distinguish publication time, the feature's launch or availability time, and retrieval time. A source's publication date alone does not establish when a feature first became available or whether it remains available now. If the event date is not supplied, preserve it as unknown rather than filling it from another date.
- Preserve words such as "new" or "newly added" as attributed source wording. Do not reinterpret them as an event occurring shortly before, after, or around the document's publication or excerpt date, including in parenthetical explanations. Without explicit event timing, neither an exact nor an approximate launch chronology is established.
- Preserve the stated provenance of supplied material. A synthetic excerpt or user-provided document title does not establish an authentic official or first-hand source.
- Preserve contradictory evidence, uncertain identity matches, source failures, and missing coverage.
- Distinguish supported facts, interpretations, and unsupported statements. Do not invent identifiers, dates, or results to fill a gap.

## Return the assessment

For each material issue, identify the affected claim, the supporting or conflicting reference, and the correction or additional evidence needed. Finish with the conclusions that remain supported and the unresolved gaps.

Apply the same evidence checks to every suggested rewrite, example, note, and conclusion. Do not introduce an unsupported date, source attribution, role, or scope while correcting the original claim. Attribute a date to what the material actually dates; if a launch date is absent, state that limitation instead of suggesting a precise launch date.

Keep a standalone supplied-material review proportional to the actual claims and evidence. Avoid repeating a speculative timeline in a final synthesis after correctly noting that the event time is unknown. A source quotation can be reported as a quotation without converting it into an independently established event.

When running inside an active investigation, preserve its existing plan, collection, analysis, review, and draft prerequisites. For a standalone review of supplied material, do not start that workflow unless the user requests it. This Skill does not grant tools, execute scripts, or change host permissions.
