# ExtractFromPage

You have the right page but the data won't come out cleanly. This is where the
sharpest in-browser research craft lives: **get more out of each page.** Interceptor
captures request/response and runs in the real signed-in Chrome with **zero CDP**,
so you can read the API the page already calls instead of parsing brittle HTML.

## Decision order (cheapest first)

1. **Plain text** — `interceptor read --text-only --full`, then `| rg` / `awk` to
   isolate the rows you need.
2. **Structure** — `interceptor read --markdown --text-only --full` for tables,
   headings, emphasized text.
3. **The API behind the page** — `inspect --net-only` / `net log` (best for JSON).
4. **JS escape hatch** — `eval --main` (link graphs, deep state, binaries).

## Scrape the data source, not the website

Most JS pages are powered by JSON. Read the endpoint the page already fetches:

```bash
interceptor inspect --net-only
interceptor net log --filter graphql --limit 10
interceptor net log --filter api --format json --out .interceptor-research/<slug>/sources/05-api.json
interceptor net headers --filter api          # infer infra/processor from request hosts
```

Reported impact in the field: ~5 min/page of brittle HTML parsing → ~2 sec/page
of clean JSON.

## Precise text extraction (token-efficient)

```bash
interceptor read --markdown --text-only --full | rg -n -C 8 'Security|pricing|benchmark'
interceptor read --text-only --full | awk '/RowStart/,/RowEnd/'     # exact table rows
interceptor text e12 --markdown                                     # one element
```

## `eval --main` as a research engine (when read fails)

```bash
# Map a site's link graph before crawling it:
interceptor eval --main "JSON.stringify([...document.querySelectorAll('a[href]')].map(a=>a.href))"

# Probe a big resource before committing to it:
interceptor eval --main "fetch(url,{headers:{Range:'bytes=0-0'}}).then(r=>({len:r.headers.get('content-length'),type:r.headers.get('content-type')}))"

# Pull a binary (PDF) through the browser context in 32KB Range chunks:
interceptor eval --main "(async()=>{const r=await fetch(url,{headers:{Range:'bytes=0-32767'}});const b=await r.arrayBuffer();return btoa(String.fromCharCode(...new Uint8Array(b)))})()"

# Surface lazy tooltips/popovers in a JS SPA, then read them:
interceptor eval --main "(async()=>{t.dispatchEvent(new MouseEvent('mouseenter',{bubbles:true}));await new Promise(r=>setTimeout(r,400));return document.querySelector('[role=tooltip]')?.innerText})()"
```

On strict-CSP sites `eval --main` retries inside the page's policy automatically;
stripping the CSP and reloading the tab needs `--allow-csp-strip`.

## Parallel fan-out (cover more sources at once)

```bash
interceptor tab new "<url-a>"
interceptor tab new "<url-b>"
interceptor read --tab <id-a> --text-only --full
interceptor read --tab <id-b> --text-only --full
```

Isolate concurrent research streams across profiles:

```bash
interceptor contexts                          # list connected context IDs (UUIDs)
interceptor --context <id> open "<url>"
```

## Save-then-grep

Dump the page to a `sources/` artifact once, then re-query the artifact instead of
re-fetching — keeps context lean and survives a dead session.

```bash
interceptor read --text-only --full > .interceptor-research/<slug>/sources/06-page.md
rg -n -C 6 '<term>' .interceptor-research/<slug>/sources/06-page.md
```
