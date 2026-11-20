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

For an evidence review, read [the evidence checklist](references/checklist.md) as your first action, before drafting any part of the answer. In Cwatch, use `session__read_skill_resource` with `skill=competitor-review` and `path=references/checklist.md`; otherwise use the available read-only file or document tool. If the user requests transcription only and forbids tools, transcribe directly.

Identify the claims, referenced sources, entity and product scope, and applicable time window. If essential evidence is missing, state the limitation and ask for or retrieve only the material necessary for the requested review.

## Review each claim

- Check that the source actually supports the named entity, product, and assertion.
- Distinguish publication time, the feature's launch or availability time, and retrieval time. A source's publication date alone does not establish when a feature first became available or whether it remains available now. If the event date is not supplied, preserve it as unknown rather than filling it from another date.
- Preserve words such as "new" or "newly added" as attributed source wording. Do not reinterpret them as an event occurring shortly before, after, or around the document's publication or excerpt date, including in parenthetical explanations. Without explicit event timing, neither an exact nor an approximate launch chronology is established.
- Preserve the stated provenance of supplied material. A synthetic excerpt or user-provided document title does not establish an authentic official or first-hand source.
- Distinguish support within the supplied material from verification of the real-world claim. A synthetic excerpt can support a claim within the exercise when its facts match the stated scope. External verification requires separate evidence.
- Preserve contradictory evidence, uncertain identity matches, source failures, and missing coverage.
- Distinguish supported facts, interpretations, and unsupported statements. Do not invent identifiers, dates, or results to fill a gap.

## Return the assessment

For each material issue, identify the affected claim, the supporting or conflicting reference, and the correction or additional evidence needed. For a short verdict, name the decisive fact and its scope so the reason is meaningful on its own. Finish with the conclusions that remain supported and the unresolved gaps.

Apply the same evidence checks to every suggested rewrite, example, note, and conclusion. Put relevant scope and source qualifications inside any wording intended for direct reuse. Do not introduce an unsupported date, source attribution, role, or scope while correcting the original claim. Attribute a date to what the material actually dates; if a launch date is absent, state that limitation instead of suggesting a precise launch date.

Keep a standalone supplied-material review proportional to the claims and evidence. Under a strict length limit, aim for roughly three quarters of the cap, including punctuation. Give each source value once, state shared scope once, and refer back to the disagreement without repeating the numbers. Keep the closing statement and verification step short but usable on their own. A source quotation can be reported as a quotation without converting it into an independently established event.

For a comparison, state each reported value with its scope and metric, decide whether those definitions support the requested comparison, and name the matching observation needed. If the measures are incompatible, finish with that limitation and the missing evidence. An extended analysis of the raw difference cannot establish the comparison.

When running inside an active investigation, preserve its existing plan, collection, analysis, review, and draft prerequisites. For a standalone review of supplied material, do not start that workflow unless the user requests it. This Skill does not grant tools, execute scripts, or change host permissions.
