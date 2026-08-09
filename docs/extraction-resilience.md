# Extraction Resilience — Increment 1

Internal design and operating notes. Written 2026-08-08; revised the same day
after a red-team pass (see *Correction history*).

## Purpose

The scanner's existing categories ask whether a page is optimised for answer
engines. Extraction Resilience asks a narrower, measurable question:

> **Does important meaning survive machine extraction?**

`4.2` in a revenue table is not the same fact as "North's 2025 revenue". A lossy
extractor returns the former and a downstream consumer may report it as the
latter.

### What this is not

**This is not "what AI sees."** We do not know what any given model or crawler
sees and do not claim to. The comparison below uses a deliberately degraded
extraction as a stress test, not as a simulation of any real consumer.

A large A/B delta means **the page is vulnerable to lossy extraction**. It does
not automatically mean the page is badly authored — the correctly marked-up
matrix table below is good HTML and still bands `fragile`, because the
information genuinely does not survive flattening.

## The two extractions

### EXTRACT_A — DOM-aware structural extraction (`extract-a.ts`)

The reference, built on **parse5 8.0.1** via a thin adapter (`dom.ts`). parse5
is the standards-oriented HTML5 tree builder: implicit `<tbody>`, foster
parenting, the adoption agency algorithm, and the rest of the error recovery
that hand-written parsers approximate badly. No browser, no renderer.

`dom.ts` exposes a small normalized node shape (`parseHtml`, `findAll`,
`findFirst`, `childElements`, `textOf`, `normalizedText`, `attr`, `hasAttr`,
`spanAttr`, `walkElements`). Everything downstream works against that shape, so
the parser swap required no changes to extraction logic and a future parser
change would not either.

EXTRACT_A preserves heading outline, table semantics (column headers, row
headers, cell grid), number/label association, units, claim qualifiers,
footnote references resolved to their text, figures paired with captions,
structured data (via the existing `extractJsonLd`), and asset counts.

### EXTRACT_B — flattened extraction (`extract-b.ts`)

Prequire's existing `stripHtml` from `lib/aeo-readiness/content-analyzer.ts`,
reused rather than reimplemented, used **deliberately as a degraded stress-test
path**.

## The three things that attach to a value

Conflating these was the central defect of the first implementation. They are
now separate types and separate measurements.

| | example | measured by |
|---|---|---|
| **Attribution** (`Dimension`) | a column header `2025`, a row header `North` | `factual_resilience` |
| **Unit** (`UnitAnnotation`) | `$`, `%`, `millions`, `months` | `unit_preservation` check |
| **Claim qualifier** (`Qualifier`) | `up to`, `average`, `unaudited`, `results may vary`, footnote ref | `qualifier_resilience` |

**Table headers and ordinary row/column attribution are never qualifiers.** A
plain matrix table with no caveats has **no** claim qualifiers, and
`qualifier_resilience` reports `not_applicable` — never `0/N`.

Qualifier vocabulary lives in `values.ts` (`QUALIFIER_VOCABULARY`) in three
groups: approximation (`up to`, `starting at`, `average`, `approximately`,
`at least`…), disclaimer (`results may vary`, `terms apply`, `not
guaranteed`…), and restriction (`unaudited`, `self-reported`, `based on a
survey`, `eligible customers`, `as of`, `limited time`…). Overlapping matches
collapse to the longest, and qualifiers stated both inline and in a referenced
footnote are deduped, so each caveat enters the denominator exactly once.

## The known test case

```
Region | 2025 | 2026
North  | 4.2  | 5.1
South  | 9.8  | 3.3
```

EXTRACT_A retains `North+2025=4.2`, `North+2026=5.1`, `South+2025=9.8`,
`South+2026=3.3`. EXTRACT_B produces:

```
Q3 Revenue by Region Region 2025 2026 North 4.2 5.1 South 9.8 3.3
```

| measure | result |
|---|---|
| `structural_resilience` | 5/9 |
| `factual_resilience` | **0/4** |
| `qualifier_resilience` | **not_applicable** (the table has no qualifiers) |
| `contradiction_count` | 0 |
| band | `fragile` |
| band rule | `factual_below_threshold` |

### Why 0/4 and not 4/4

A fact is the tuple **(label, every dimension, value)**. `South | 2025 | 9.8` is
a different fact from `South | 2026 | 3.3`.

In the flattened stream the row label survives — `South` is adjacent to `9.8`.
The column label does not. `2025` and `2026` both sit near the value at
comparable distance, so nothing in the flattened text says which figure is
which. A fact only counts as preserved when **one occurrence of its value
carries the label and every dimension unambiguously**. None of the four do.

That is the fixture's whole purpose: the *values* survive, the *relationships*
do not, and the band must fail for that reason rather than on an inapplicable
qualifier metric.

## Measures

Four figures. Numerator and denominator are always retained: `1/1` and `40/40`
are not the same evidence.

- `structural_resilience` — preserved / assessed
- `factual_resilience` — preserved / assessed
- `qualifier_resilience` — preserved / assessed
- `contradiction_count` — integer

An unlabeled value counts against `factual_resilience` as a loss: its meaning is
already gone in the source. A fact whose column attribution is defeated by
`rowspan`/`colspan` is counted as **undeterminable** — excluded from the
denominator and surfaced, never guessed.

## Status contract

`pass` · `warning` · `fail` · `undeterminable` · `not_applicable`

- **`undeterminable`** is surfaced and **excluded from every denominator**.
- **`not_applicable`** never penalises the page.

Deliberately different from the scanner's existing `CheckItem` statuses
(`pass`/`warn`/`fail`/`not_assessable`), which are untouched so no existing
scoring moves. Two vocabularies now coexist — see *Risks*.

## Checks (all deterministic)

`table_semantics`, `number_label_association`, `unit_preservation`,
`qualifier_preservation`, `footnote_reachability`, `schema_body_contradiction`,
`entity_consistency`, `fact_attribution`, `extraction_delta`, and
`visual_fact_reachability`.

`visual_fact_reachability` is **always `undeterminable` or `not_applicable`** in
Increment 1 — never pass, never fail.

## Band rules (`bands.ts`)

Ordered; first match wins. Each returns a stable `rule` id alongside the band,
so the trigger is machine-checkable rather than inferred from prose.

1. `coverage_below_minimum` → `insufficient_evidence` (< 4 total observations)
2. `no_readable_facts_with_undeterminable_visuals` → `insufficient_evidence`
3. `important_contradiction` → `fragile` (short-circuits)
4. `qualifier_below_threshold` → `fragile` (ratio < 0.5; skipped when n/a)
5. `factual_below_threshold` → `fragile` (ratio < 0.5)
6. `structural_below_threshold` → `fragile` (ratio < 0.5)
7. `all_measures_strong_but_thin_evidence` → `mostly_resilient` (< 8 observations)
8. `all_measures_strong` → `resilient` (all ≥ 0.9, no contradictions)
9. `all_measures_adequate` → `mostly_resilient` (all ≥ 0.7)
10. `weakest_measure_below_adequate` → `fragile`

Measures with `assessed === 0` are skipped entirely — a `not_applicable`
qualifier measure can never trigger rule 4.

### Fixture behaviour

| fixture | band | rule | struct | fact | qual | contra |
|---|---|---|---|---|---|---|
| `strong-semantic` | resilient | `all_measures_strong` | 14/14 | 7/7 | 2/2 | 0 |
| `no-schema` | mostly_resilient | `all_measures_strong_but_thin_evidence` | 4/4 | 3/3 | n/a | 0 |
| `matrix-table` | fragile | `factual_below_threshold` | 5/9 | **0/4** | **n/a** | 0 |
| `qualified-claims` | fragile | `qualifier_below_threshold` | 1/2 | 5/5 | **5/12** | 0 |
| `unlabeled-numbers` | fragile | `factual_below_threshold` | 3/3 | 1/5 | n/a | 0 |
| `schema-body-conflict` | fragile | `important_contradiction` | 1/1 | 3/3 | n/a | **2** |
| `image-trapped-facts` | insufficient_evidence | `no_readable_facts_with_undeterminable_visuals` | 4/5 | n/a | n/a | 0 (5 undet.) |
| `ambiguous-identity` | insufficient_evidence | `coverage_below_minimum` | n/a | n/a | n/a | 0 |
| `weak-headings` | insufficient_evidence | `coverage_below_minimum` | 2/2 | 1/1 | n/a | 0 |

## Where it sits, and what did not change

`extraction_resilience` is a **sibling of `categories`**, never a member.
`computeOverallScore()` reads only `contentQuality`, `schemaMarkup`, and
`performance`, so this cannot move the headline AEO score. Route tests assert
that, including on a page that bands `fragile`. The call is non-fatal.

**No migration required** — `scan_results.result_json` is `jsonb`.

`computeOverallScore()` and `computeAccessibilityScore()` are untouched.
`extractJsonLd()` gained two additive fields (`nodes`, `blockCount`).
`stripHtml()` gained the `export` keyword and a comment; its body is
byte-identical, proven by `content-analyzer.regression.test.ts`, which runs the
current function against a verbatim copy of the pre-change implementation over
every existing fixture plus ten edge cases.

## Correction history

The first implementation had three defects a red-team pass caught:

1. **Qualifier denominator.** Table column headers were counted as qualifiers,
   producing `0/16` on a table with no qualifiers and banding it `fragile` for
   the wrong reason. Attribution, units, and claim qualifiers are now separate
   types with separate measures.
2. **Fact survival was too lenient.** Label adjacency alone counted as survival,
   giving `4/4` on the known table. Survival now requires the full tuple.
3. **Hand-written parser.** Replaced with parse5.

Two earlier self-caught defects: a definition-list relation emitted
anchor-first while table relations were dependent-first (orientation is now
fixed and documented on `StructuralRelation`), and footnote qualifiers
"surviving" by document-order proximity.

## Current limitations

- **No visual analysis.** Reported `undeterminable`, never pass or fail.
- **No JavaScript execution.** Server-delivered HTML only.
- **`rowspan` is not resolved.** Tables using it report column attribution as
  undeterminable rather than guessing. `colspan` in the header row is handled.
- **Fact extraction is recall-limited.** Values are found in tables, definition
  lists, `label: value` phrasing, and standalone value elements. Values embedded
  in ordinary prose without a colon are missed, so `number_label_association`
  measures labelling quality *among values found*.
- **Qualifier detection is vocabulary-based**, so unusual phrasing is missed.
- **Non-numeric facts are out of scope** in Increment 1.
- **Adjacency is a proxy for recoverability.** A 6-token label window and a
  4-token attribution window with an ambiguity test. These are judgement calls,
  not measurements, and are the most arbitrary numbers in the system.
- **This is not an accessibility or WCAG assessment.**

## Increment 2 — Visual Information Parity

Types exist and are exported; nothing is stubbed into behaviour. `VisualClaim`,
`ClaimComparison` (`exact_match | semantic_match | partial | absent |
conflict`), `VisualParityReport` (always `null`), and
`AssetCounts.imageCandidates[]` as the input queue.

**Clean next step:** filter `imageCandidates` to chart-like graphics, send them
to a vision model under a strict schema, validate through `guard.ts`, then
compare each claim against `extractA.bindings`. Turning
`visual_fact_reachability` from `undeterminable` into a scored check requires no
band-rule change — a `conflict` becomes an important contradiction and
short-circuits through rule 3.

The model's role stays evidence-only: it may report what a chart says. It may
not score, band, or set a check status.
