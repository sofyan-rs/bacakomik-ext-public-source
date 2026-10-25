## What

<!-- One line. Use the commit message format: feat(<id>): <what changed> (<version>) -->

## Type

- [ ] New extension
- [ ] Fix an extension
- [ ] New feature in an extension
- [ ] Remove an extension
- [ ] Docs / scripts / CI

## Extension

- ID: `<id>`
- Version: `<old>` -> `<new>`
- Site: <!-- https://... -->

## Checklist

- [ ] `bun scripts/run.ts <id> smoke` passes
- [ ] `bun run typecheck` passes
- [ ] `version` in `meta.json` is bumped (if `index.js` changed)
- [ ] `bun run build` was run after the last change
- [ ] `src/<id>` and `dist/` are both committed
- [ ] Credit note and README row added (if ported from keiyoushi)

## Smoke output

<!-- Paste the last lines of `bun scripts/run.ts <id> smoke`. -->

```
```

## Notes

<!-- Site quirks, Cloudflare, known problems. Delete if none. -->
