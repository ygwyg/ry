# Evaluation results

**Test site:** 662 real pages from the Cloudflare docs (Workers, Workers AI, R2, D1, KV, Durable Objects, Queues).

**114 labeled broken URLs:**
- 40 typos
- 37 synonyms (`/workers/cost`, `/queues/dlq`)
- 15 pages from an older URL structure
- 12 URLs with no matching page
- 10 bot probes

**Setup:** `clef-flash` through Workers AI on 2026-10-01. Each category has 10–40 cases, so differences under ~5 points are one or two cases and shouldn't be over-read.

## Where we started and where we are

| | Original (v0.1) | Now |
| --- | --- | --- |
| Correct redirect | 57% | **76%** |
| Wrong redirect | 1% | **0%** |
| Right page offered (redirect or suggestion) | 89% | **97%** |
| Redirected when it shouldn't (no match, bots) | 9% | **5%** |
| Answered without calling Clef | 0% | **35%** |
| Clef time, median | 0.72s | 0.98s (0.75s one round, 1.4s two) |

The 5% "shouldn't" redirect is a single case: `/partners/reseller-program` went to R2's "Partners" page.

| By category | Original | Now |
| --- | --- | --- |
| Typo | 63% | **100%**, no AI call |
| Synonym | 49% | **59%** |
| Moved page | 60% | 53% |

## What we tried

### Round 1: how to shortlist pages for Clef

| | Spelling only, 60 | Spelling + meaning, 60 | Spelling only, 254 | Spelling + meaning, 120 |
| --- | --- | --- | --- | --- |
| Right page shortlisted | 96% | **100%** | 100% | 100% |
| Correct redirect | **57%** | 50% | 26% | 45% |
| Right page offered | 89% | 89% | 85% | 89% |

**Findings:**
- **Clef's confidence drops as options grow.** Sending all 254 allowed pages cut correct redirects in half. A tight shortlist matters.
- **Meaning-based shortlisting** (embeddings) catches every synonym and moved page that spelling alone missed.
- **Finding the page wasn't the bottleneck.** Clef ranked the right page first about 89% of the time, but often at 0.3–0.5, below the threshold.

### Round 2: typo fix and section names

- **Typo fix:** a URL one or two keystrokes from exactly one page now redirects without calling Clef. Typos went from 58% to 100% correct and 35% of all requests skip AI.
- **Section names:** pages with duplicate titles get their section added ("Pricing (workers platform)"). `/workers/cost` went from a miss at 0.49 to a redirect at 0.56.

### Round 3: descriptions from the first paragraph

Only 268 of 662 pages had a meta description. Filling the rest from the page's first paragraph:
- raised "right page offered" from 91% to 95%
- dropped "redirected when it shouldn't" from 5% to 0%
- slightly lowered correct redirects (70% → 66%) because confidence spreads across better-described rivals

### Round 4: a second, narrower question

When Clef is unsure, ask again with only its top 5 pages.

| | One round | Top 5 again | Top 3 again |
| --- | --- | --- | --- |
| Correct redirect | 66% | **76%** | 78% |
| Wrong redirect | 0% | **0%** | 1% |
| Redirected when it shouldn't | 0% | 5% | 5% |
| Asked twice | 0% | 31% | 31% |

**Top 5** gets nearly all the gain without the wrong redirect that top 3 introduced, so it's the default.

## Reproduce

See [README.md](README.md).
