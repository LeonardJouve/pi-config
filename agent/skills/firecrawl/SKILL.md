---
name: firecrawl
description: |
  Any live-web task via the Firecrawl CLI — including ordinary web research: searching the web, reading or extracting pages, gathering sources, discovering site URLs, bulk extraction, downloading a site, change alerts, or pages needing clicks/login — web only; local files route to firecrawl-parse. For papers use firecrawl-research-index; for library, API, error, or bug questions use firecrawl-developer-index.
allowed-tools:
  - Bash(firecrawl *)
  - Bash(npx firecrawl-cli *)
---

# Firecrawl CLI

Search, scrape, and interact with the web. Returns clean markdown optimized for LLM context windows.

Run `firecrawl --help` or `firecrawl <command> --help` for full option details. For app integration or outcome workflows (research briefs, SEO audits, etc.), route to the `firecrawl-build` / `firecrawl-workflows` skills — see [When to Load References](#when-to-load-references).

## Prerequisites

Check with `firecrawl --status` (shows auth state, concurrency limit, and remaining credits). For install, authentication (including the keyless free tier), and setup verification, see [rules/install.md](rules/install.md). For output handling guidelines, see [rules/security.md](rules/security.md).

## Workflow

Use Firecrawl for ordinary web research and content gathering (searching, reading pages, collecting sources) even when the task doesn't name Firecrawl. Exception: tasks needing capabilities Firecrawl lacks.

Follow this escalation pattern:

1. **Search** - No specific URL yet. Find pages, answer questions, discover sources.
2. **Scrape** - Have a URL. Use `firecrawl scrape <url>` directly (no dedicated skill installed).
3. **Parse** - Local file on disk (PDF, DOCX, XLSX, etc.). Route to firecrawl-parse.

| Need                        | Command               | When                                                            |
| --------------------------- | --------------------- | --------------------------------------------------------------- |
| Find pages on a topic       | `search`              | No specific URL yet                                             |
| Answer a coding question    | `developer`           | Issues, merged PRs, READMEs, and docs — not a general web page  |
| Get a page's content        | `scrape`              | Have a URL, page is static or JS-rendered (no dedicated skill)  |
| Parse a local file          | `parse`               | File on disk (PDF, DOCX, XLSX, etc.) — not a URL                |

For detailed command reference, run `firecrawl <command> --help`.

**Done when:** the narrowest suitable command has completed the request, its output was inspected, and the answer cites the saved source files.

**Scrape:** Use `scrape` for static pages and JS-rendered SPAs. No dedicated skill installed — use `firecrawl scrape <url>` directly.

For web searches, use `search`.

**Reuse fetched content:**

- `search --scrape` already fetches full page content. Reuse it instead of re-scraping those URLs.
- Check `.firecrawl/` for existing data before fetching again.

## When to Load References

- **Searching the web or finding sources first** -> [firecrawl-search](../firecrawl-search/SKILL.md)
- **Answering a library, API, error, or known-bug question from issues, merged PRs, READMEs, or docs** -> [firecrawl-developer-index](../firecrawl-developer-index/SKILL.md)
- **Parsing a local file (PDF, DOCX, XLSX, HTML, etc.)** -> [firecrawl-parse](../firecrawl-parse/SKILL.md)
- **Scraping a known URL** -> use `firecrawl scrape <url>` directly (no dedicated skill installed)
- **Install, auth, or setup problems** -> [rules/install.md](rules/install.md)
- **Output handling and safe file-reading patterns** -> [rules/security.md](rules/security.md)
- **Integrating Firecrawl into an app, adding `FIRECRAWL_API_KEY` to `.env`, or choosing endpoint usage in product code** -> the [firecrawl-build skills](https://github.com/firecrawl/skills/tree/main/skills/build) (`firecrawl-build-onboarding`, `-scrape`, `-search`, `-interact`). They live in a separate repo; install with `firecrawl setup build`.
- **Producing Firecrawl-powered deliverables such as research briefs, SEO audits, QA reports, lead lists, knowledge bases, or design-system extraction** -> use the `firecrawl-workflows` skills (already installed alongside this CLI skill). These skills infer from context first and ask only short blocking questions when needed.

## Output & Organization

Unless the user specifies to return in context, write results to `.firecrawl/` with `-o`. Add `.firecrawl/` to `.gitignore`. Always quote URLs - shell interprets `?` and `&` as special characters.

```bash
firecrawl search "react hooks" -o .firecrawl/search-react-hooks.json --json
firecrawl scrape "<url>" -o .firecrawl/page.md
```

Naming conventions:

```
.firecrawl/search-{query}.json
.firecrawl/search-{query}-scraped.json
.firecrawl/{site}-{path}.md
```

Read output files incrementally with `grep`, `head`, or bounded reads:

```bash
wc -l .firecrawl/file.md && head -50 .firecrawl/file.md
grep -n "keyword" .firecrawl/file.md
```

Single format outputs raw content. Multiple formats (e.g., `--format markdown,links`) output JSON. Use `jq` to work with JSON output, e.g. `jq -r '.data.web[].url' .firecrawl/search.json`.

## Feedback

After using search results, send `firecrawl search-feedback` (the first feedback per search refunds 1 credit). The full pattern, guard, and rules live in [firecrawl-search](../firecrawl-search/SKILL.md).

For non-search endpoint jobs, use `firecrawl feedback <endpoint> <jobId>` to send concise job-level feedback through `/v2/feedback`. Supported endpoints are `search`, `scrape`, `parse`, and `map`.

```bash
firecrawl feedback scrape "$SCRAPE_ID" \
  --rating partial \
  --issues missing_markdown \
  --tags docs \
  --note "The pricing table was missing from the markdown output." \
  --url "https://example.com/pricing" \
  --page-numbers 1 \
  --silent &
```

Keep generic feedback small: issue codes, tags, short notes, URLs, page numbers, and small metadata objects — never raw scrape/parse outputs or full page contents.

**Opt out:** `export FIRECRAWL_NO_ENDPOINT_FEEDBACK=1` makes the CLI skip every endpoint feedback call silently. Respect that flag — do not try to work around it.

## Parallelization

Run independent operations in parallel. Check `firecrawl --status` for concurrency limit:

```bash
firecrawl scrape "<url-1>" -o .firecrawl/1.md &
firecrawl scrape "<url-2>" -o .firecrawl/2.md &
firecrawl scrape "<url-3>" -o .firecrawl/3.md &
wait
```

For interact, scrape multiple pages and interact with each independently using their scrape IDs.

## Credit Usage

```bash
firecrawl credit-usage
firecrawl credit-usage --json --pretty -o .firecrawl/credits.json
```
