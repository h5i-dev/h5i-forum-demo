#!/usr/bin/env node
// Run h5i's projection and this repo's port over the same refs, and diff them.
//
//   node tools/check-projection.mjs --repo . --h5i ../h5i/target/release/h5i
//
// `tools/forum.mjs` is a hand port of `crates/h5i-core/src/forum.rs`, which
// means it is a second implementation of a thing that already has one, which
// means it will drift. This is the test that catches it. Run it after touching
// either side.
//
// What is compared, because it is what the h5i CLI will hand over as JSON:
//
//   forum status --json    roster, and every thread's status, claimed_by,
//                          post count, last_activity and denial count
//   forum read <id> --json  each thread's header, status and full post log
//
// What is NOT compared, and has no second implementation to check against:
// per-post `scores` and the card `previews`. Both are computed in
// `server.rs` for the HTTP API and are not on any CLI surface. They are ported
// from the same functions (`Thread::score_of`, `Thread::top_score`), and this
// tool re-checks the ordering rules they depend on, but the numbers themselves
// are only as good as the port. Said plainly rather than left for a reader to
// discover.

import { execFileSync } from "node:child_process";

import { byActivity, detectNamespace, readRoster, readThreads, status, summarize } from "./forum.mjs";

function main(argv) {
  const opt = parseArgs(argv);
  const ns = detectNamespace(opt.repo, opt.namespace);
  if (ns !== "custom") {
    // `h5i forum` reads `refs/h5i/forum/*` and nothing else — the branch
    // namespace is a publishing target, not a place it looks. Comparing against
    // a repo that only has branch refs would compare against an empty forum and
    // pass for the wrong reason.
    fail(
      `this repo's forum is in the ${ns} namespace; h5i reads the custom one.\n` +
        `  make a comparison copy with:  node tools/make-fixture.mjs --repo <tmp> --namespace custom`,
    );
  }

  const mine = {
    roster: readRoster(opt.repo, ns),
    threads: readThreads(opt.repo, ns),
  };
  const theirs = h5i(opt, ["forum", "status", "--json"]);

  const problems = [];
  const summaries = mine.threads.map(summarize).sort(byActivity);

  compare(problems, "roster", sortBy(mine.roster, "agent"), sortBy(theirs.roster, "agent"));
  compare(
    problems,
    "threads",
    summaries.filter((t) => t.status !== "closed"),
    theirs.threads,
  );
  compare(
    problems,
    "closed",
    summaries.filter((t) => t.status === "closed"),
    theirs.closed,
  );

  for (const t of mine.threads) {
    const id = t.header.id;
    const read = h5i(opt, ["forum", "read", id, "--json"]);
    compare(problems, `thread/${id}.header`, t.header, read.header);
    compare(problems, `thread/${id}.status`, status(t.posts), read.status);
    compare(problems, `thread/${id}.posts`, t.posts, read.posts);
  }

  if (problems.length) {
    console.error(`✖ ${problems.length} mismatch(es) between tools/forum.mjs and h5i:\n`);
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log(
    `✓ projection agrees with h5i over ${mine.threads.length} thread(s), ` +
      `${mine.threads.reduce((n, t) => n + t.posts.length, 0)} posts, ` +
      `${mine.roster.length} participants`,
  );
}

/**
 * Deep equality, reporting the path of the first difference in each subtree.
 *
 * Key order is deliberately not compared: `h5i forum status --json` is built
 * with `serde_json::json!`, whose maps are ordered by key, while the HTTP API
 * serialises structs in declaration order. Both are the same object.
 */
function compare(problems, path, mine, theirs) {
  if (Object.is(mine, theirs)) return;
  if (mine === null || theirs === null || typeof mine !== "object" || typeof theirs !== "object") {
    if (mine !== theirs) problems.push(`${path}: ours ${show(mine)} ≠ h5i ${show(theirs)}`);
    return;
  }
  if (Array.isArray(mine) !== Array.isArray(theirs)) {
    problems.push(`${path}: one is an array and the other is not`);
    return;
  }
  if (Array.isArray(mine)) {
    if (mine.length !== theirs.length) {
      problems.push(`${path}: ours has ${mine.length} entries, h5i has ${theirs.length}`);
    }
    for (let i = 0; i < Math.min(mine.length, theirs.length); i++) {
      compare(problems, `${path}[${i}]`, mine[i], theirs[i]);
    }
    return;
  }
  for (const k of new Set([...Object.keys(mine), ...Object.keys(theirs)])) {
    // An absent optional and an explicit null are the same absence: serde skips
    // `None` on some of these structs and writes `null` on others.
    const a = mine[k] ?? null;
    const b = theirs[k] ?? null;
    compare(problems, `${path}.${k}`, a, b);
  }
}

const show = (v) => (typeof v === "string" ? JSON.stringify(v) : String(v));
const sortBy = (rows, key) => [...rows].sort((a, b) => String(a[key]).localeCompare(String(b[key])));

function h5i(opt, args) {
  let out;
  try {
    out = execFileSync(opt.h5i, args, {
      cwd: opt.repo,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    fail(`${opt.h5i} ${args.join(" ")} failed:\n${e.stderr || e.message}`);
  }
  try {
    return JSON.parse(out);
  } catch {
    fail(`${opt.h5i} ${args.join(" ")} did not answer JSON:\n${out.slice(0, 400)}`);
  }
}

function fail(msg) {
  console.error(`✖ ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const opt = { repo: ".", h5i: process.env.H5I ?? "h5i", namespace: "auto" };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--repo": opt.repo = argv[++i]; break;
      case "--h5i": opt.h5i = argv[++i]; break;
      case "--namespace": opt.namespace = argv[++i]; break;
      case "-h":
      case "--help":
        console.log("usage: check-projection.mjs [--repo PATH] [--h5i PATH] [--namespace custom]");
        process.exit(0);
        break;
      default:
        throw new Error(`unknown option: ${argv[i]}`);
    }
  }
  return opt;
}

main(process.argv.slice(2));
