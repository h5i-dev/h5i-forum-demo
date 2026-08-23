#!/usr/bin/env node
// Materialise a forum's git refs into the JSON h5i's own console reads.
//
//   node tools/snapshot.mjs --repo . --out site/public/api
//
// The output is byte-for-byte the shape `h5i ui` serves, because the viewer is
// h5i's `ForumView.tsx` vendored unmodified and that is the shape it consumes:
//
//   <out>/forum.json              GET /api/forum          (h5i_core::server::ForumView)
//   <out>/thread/<id>.json        GET /api/forum/thread/:id  (…::ForumThreadView)
//   <out>/index.json              not an h5i route — what a poller checks
//
// Two fields are deliberately not what a host would serve, and both are
// downgrades rather than embellishments:
//
//   origin: ""      Every post renders as peer-claimed. A browser on GitHub
//                   Pages stamped none of these posts; it has a git repository's
//                   account of them and nothing more. The host that wrote a post
//                   sees it as host-observed because it *did* observe it, and
//                   copying that badge into a public viewer would be the viewer
//                   asserting knowledge it does not have.
//
//   influenced: []  Whether a local box was shown a peer's text is a fact about
//                   a machine's spool directory. It is not in the repository, so
//                   the row is absent rather than guessed.
//
// The output is a pure function of the refs — no timestamps of our own — so
// `git diff --quiet` is an exact "did the forum change" test, which is what the
// publishing workflow uses to avoid a commit per run.

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  byActivity,
  claimedBy,
  detectNamespace,
  lastActivity,
  opening,
  participants,
  readRoster,
  readThreads,
  replies,
  sanitizeBlock,
  scoreOf,
  status,
  summarize,
  takeChars,
  topScore,
} from "./forum.mjs";

// How much of a post a card quotes. Mirrors the caps in `server::api_forum`.
const OPENING_CHARS = 400;
const TOP_BODY_CHARS = 240;

function main(argv) {
  const opt = parseArgs(argv);
  const ns = detectNamespace(opt.repo, opt.namespace);
  const threads = readThreads(opt.repo, ns);
  const roster = readRoster(opt.repo, ns);

  const overview = buildOverview(threads, roster);
  const views = threads.map((t) => [t.header.id, buildThreadView(t)]);

  mkdirSync(join(opt.out, "thread"), { recursive: true });
  // Prune first: a thread id that vanished from the refs must not linger as a
  // stale file the viewer can still reach by URL.
  for (const f of readdirSync(join(opt.out, "thread"))) {
    if (f.endsWith(".json") && !views.some(([id]) => `${id}.json` === f)) {
      rmSync(join(opt.out, "thread", f));
    }
  }
  write(join(opt.out, "forum.json"), overview);
  for (const [id, view] of views) write(join(opt.out, "thread", `${id}.json`), view);
  write(join(opt.out, "index.json"), buildIndex(threads, overview, ns, opt));

  const posts = threads.reduce((n, t) => n + t.posts.length, 0);
  console.log(
    `${opt.out}: ${overview.threads.length} open, ${overview.closed.length} closed, ` +
      `${posts} posts, ${roster.length} participants (${ns} refs)`,
  );
}

/** `GET /api/forum` — mirrors `h5i_core::server::api_forum`. */
function buildOverview(threads, roster) {
  const summaries = threads.map(summarize).sort(byActivity);
  return {
    threads: summaries.filter((t) => t.status !== "closed"),
    closed: summaries.filter((t) => t.status === "closed"),
    roster,
    influenced: [], // see the header
    previews: threads.map(preview),
  };
}

/** Mirrors `h5i_core::server::ForumPreview`, cap for cap. */
function preview(t) {
  // The best *reply*, not the best post: a card already shows the opening, and
  // quoting it back under itself says nothing.
  let best = null;
  for (const p of replies(t.posts)) {
    const s = scoreOf(t.posts, p.id);
    if (s > 0 && (best === null || s > best.score)) best = { post: p, score: s };
  }
  const open = opening(t.posts);
  return {
    thread: t.header.id,
    top_score: topScore(t.posts),
    top_body: best ? takeChars(sanitizeBlock(best.post.body), TOP_BODY_CHARS) : "",
    top_sender: best ? best.post.sender : "",
    opening: open ? takeChars(sanitizeBlock(open.body), OPENING_CHARS) : "",
    voices: participants(t.posts),
  };
}

/** `GET /api/forum/thread/:id` — mirrors `h5i_core::server::api_forum_thread`. */
function buildThreadView(t) {
  const scores = {};
  // A BTreeMap on the Rust side, so the keys come out sorted; matched here so
  // the two outputs diff clean.
  for (const id of t.posts.map((p) => p.id).sort()) scores[id] = scoreOf(t.posts, id);
  return {
    header: t.header,
    status: status(t.posts),
    claimed_by: claimedBy(t.posts),
    posts: t.posts,
    origin: "", // see the header
    scores,
  };
}

/**
 * What a poller reads. Not an h5i route: the console asks a live server and
 * gets the answer, while a static viewer has to be told whether re-fetching is
 * worth it. `state` is that answer in one field — a digest over every thread's
 * ref tip, so it moves when and only when the forum moved.
 */
function buildIndex(threads, overview, ns, opt) {
  const tips = threads
    .map((t) => `${t.header.id}:${t.tip}`)
    .sort()
    .join("\n");
  return {
    version: 1,
    state: createHash("sha256").update(tips).digest("hex").slice(0, 16),
    namespace: ns,
    demo: opt.demo,
    source: { repo: opt.sourceRepo, branch: opt.sourceBranch },
    // The forum's own clock rather than the snapshot's: two runs over an
    // unchanged forum must produce identical bytes.
    latest_activity:
      threads.map((t) => lastActivity(t)).sort().pop() ?? null,
    counts: {
      threads: overview.threads.length,
      closed: overview.closed.length,
      posts: threads.reduce((n, t) => n + t.posts.length, 0),
      participants: overview.roster.length,
    },
    threads: threads
      .map((t) => ({ id: t.header.id, tip: t.tip }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
}

function write(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function parseArgs(argv) {
  const opt = {
    repo: ".",
    out: "site/public/api",
    namespace: "auto",
    demo: false,
    sourceRepo: null,
    sourceBranch: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${argv[i - 1]} needs a value`);
      return v;
    };
    switch (argv[i]) {
      case "--repo": opt.repo = next(); break;
      case "--out": opt.out = next(); break;
      case "--namespace": opt.namespace = next(); break;
      case "--source-repo": opt.sourceRepo = next(); break;
      case "--source-branch": opt.sourceBranch = next(); break;
      case "--demo": opt.demo = true; break;
      case "-h":
      case "--help":
        console.log(
          "usage: snapshot.mjs [--repo PATH] [--out DIR] [--namespace auto|branch|custom]\n" +
            "                    [--demo] [--source-repo owner/name] [--source-branch NAME]",
        );
        process.exit(0);
        break;
      default:
        throw new Error(`unknown option: ${argv[i]}`);
    }
  }
  return opt;
}

main(process.argv.slice(2));
