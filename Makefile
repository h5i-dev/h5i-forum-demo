# Everything you can do to this repository from a terminal.
#
#   make fixture    rebuild the demo conversation and the snapshot it produces
#   make snapshot   snapshot a real forum out of this repository's refs
#   make check      diff this repo's projection against h5i's own
#   make dev        the viewer, against the snapshot in the tree
#   make build      what the Pages workflow builds
#
# The fixture is written into a scratch repository rather than into this one, on
# purpose. Real forum refs on this repository mean a real forum, and the
# workflows treat them that way — the demo would lose the band that says it is
# a demo. What is committed here is the *snapshot*, which carries `demo: true`
# and says so on the page.

FIXTURE ?= .fixture
H5I     ?= h5i
SITE    ?= site

.PHONY: fixture snapshot check dev build clean

fixture:
	rm -rf $(FIXTURE)
	git init -q $(FIXTURE)
	git -C $(FIXTURE) commit -q --allow-empty -m "scratch repository for the demo forum"
	node tools/make-fixture.mjs --repo $(FIXTURE) --namespace branch
	node tools/snapshot.mjs --repo $(FIXTURE) --out $(SITE)/public/api --namespace branch --demo

# A forum that this repository actually holds. `h5i forum sync --branch-refs`
# puts it there; this turns it into the JSON the viewer reads. The workflows run
# exactly this, so running it by hand is how you see what they will produce.
snapshot:
	node tools/snapshot.mjs --repo . --out $(SITE)/public/api --namespace branch

# `tools/forum.mjs` is a hand port of h5i's projection, so it can drift. This
# runs both over the same refs and diffs the JSON. Needs a h5i build new enough
# to have `h5i forum`:
#
#   make check H5I=../h5i/target/release/h5i
check:
	rm -rf $(FIXTURE)-custom
	git init -q $(FIXTURE)-custom
	git -C $(FIXTURE)-custom commit -q --allow-empty -m "scratch repository for the projection check"
	node tools/make-fixture.mjs --repo $(FIXTURE)-custom --namespace custom
	node tools/check-projection.mjs --repo $(FIXTURE)-custom --h5i $(H5I)

dev:
	npm --prefix $(SITE) install
	npm --prefix $(SITE) run dev

build:
	npm --prefix $(SITE) ci
	npm --prefix $(SITE) run build

clean:
	rm -rf $(FIXTURE) $(FIXTURE)-custom $(SITE)/dist $(SITE)/node_modules
