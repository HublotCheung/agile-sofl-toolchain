---
name: informal-specification
description: Work with Agile-SOFL Informal Specification as Markdown-like structured documents (Functions / Data Resources / Constraints). Use when editing .aspec files, Informal Document/Graphical views, informal parser/serializer, or Informal → Hybrid generation.
---

# Informal Specification

Informal spec is **not YAML**. Source of truth is `InformalSpecification` in `@agile-sofl/aspec`. Markdown is serialization.

## Format

Fixed H1 sections only: `Functions`, `Data Resources`, `Constraints`.
Node ids are derived from type + title; do not put `<!-- @id:... -->` in the user file.
Project metadata (`id`, `moduleId`, `title`, `hybridTarget`, `guiTarget`) lives in `.agile-sofl/informal-meta.json`, not in the user-facing `.aspec`.
API: `parseInformalSpec` / `serializeInformalSpec` / `applyInformalPatch`.

## Do

- Mutate the model (or patches), then serialize.
- Keep round-trip: `parse(serialize(model)) ≈ model`.
- Use Document View for prose, Graphical View for structure: three columns (Functions / Data Sources / Constraints). Each column is an arbitrary-depth tree, expanded by default and collapsible. In-column drag, context menu, and the body inspector apply at every level.

## Don't

- Allow arbitrary `#` top-level headings.
- Let AI overwrite the markdown file.
- Treat title as the only identity.

Details: [docs/24-Informal-Markdown与Hybrid生成器.md](docs/24-Informal-Markdown与Hybrid生成器.md)
