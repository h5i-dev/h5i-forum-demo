#!/usr/bin/env bash
# Re-copy the files this site vendors from h5i, and re-stamp their provenance.
#
#   tools/vendor-sync.sh ../h5i
#
# The three files below are h5i's forum surface, used here unmodified. That is
# the point of the whole exercise — this viewer's claim is that it renders a
# forum the way h5i's own console renders it — so the right way to pick up a
# change is to copy it again, not to patch it here.
#
# After a resync, check three things:
#
#   * `site/src/api.ts` still satisfies what `ForumView.tsx` imports. It is the
#     only seam, and a new field on `ForumOverview` or `ForumThread` has to be
#     added to `tools/snapshot.mjs` as well or the view reads `undefined`.
#   * `make check` still passes, against a h5i built from the same commit.
#   * `forum.css` has not started reading a token that only `theme.css` defines.
#     `site/src/base.css` carries the five it needed as of the stamp below.
set -euo pipefail

src="${1:-../h5i}"
[ -d "$src/web/src" ] || { echo "not a h5i checkout: $src" >&2; exit 1; }

sha=$(git -C "$src" rev-parse HEAD)
here=$(cd "$(dirname "$0")/.." && pwd)

stamp_ts() {
  printf '// Vendored verbatim from h5i — do not edit here.\n//\n//   source: web/src/%s @ %s\n//   resync: tools/vendor-sync.sh\n//\n// It is unmodified on purpose: this viewer'"'"'s claim is that it renders the forum\n// the way h5i'"'"'s own console renders it, and a patched copy would quietly stop\n// being that. Everything this viewer needs to change lives in api.ts — the\n// snapshot it reads carries `origin: ""` and `influenced: []`, which is what\n// makes every post render as peer-claimed and drops the influence row.\n\n' "$1" "$sha"
}

for f in ForumView.tsx markdown.tsx; do
  { stamp_ts "$f"; cat "$src/web/src/$f"; } > "$here/site/src/$f"
done

{
  printf '/* Vendored verbatim from h5i — do not edit here.\n *\n *   source: web/src/forum.css @ %s\n *   resync: tools/vendor-sync.sh\n *\n * The `--bp-*`, `--h5-accent` and `--font-ui` tokens this file reads live in\n * h5i'"'"'s theme.css, which also carries the console this viewer does not ship.\n * base.css defines just those tokens instead.\n */\n\n' "$sha"
  cat "$src/web/src/forum.css"
} > "$here/site/src/forum.css"

echo "vendored ForumView.tsx, markdown.tsx, forum.css from $src @ ${sha:0:9}"
