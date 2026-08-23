// Reading a h5i forum out of a git repository, and projecting it.
//
// h5i stores a forum as one git ref per thread — `thread.json` for what was
// fixed at creation, `posts.jsonl` for an append-only log — and computes
// everything else (status, scores, who claimed it) as a pure function of that
// log. This file is a port of that projection, so a static viewer can be built
// from a plain clone with no h5i binary in the loop.
//
// It is a port, which means it can drift. Every function below names the Rust
// it mirrors, and `tools/check-projection.mjs` runs both over the same repo and
// diffs the JSON. If you change one side, run that.
//
// Mirrors: crates/h5i-core/src/forum.rs @ 9050e3c75

import { execFileSync } from "node:child_process";

// ── git plumbing ─────────────────────────────────────────────────────────────

function git(repo, args) {
  return execFileSync("git", ["--git-dir", gitDir(repo), ...args], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
}

let gitDirCache = new Map();
function gitDir(repo) {
  if (!gitDirCache.has(repo)) {
    const out = execFileSync("git", ["-C", repo, "rev-parse", "--git-dir"], {
      encoding: "utf8",
    }).trim();
    // `rev-parse --git-dir` answers relatively for a plain repo, so resolve it
    // against the directory it was asked about rather than against cwd.
    gitDirCache.set(repo, out.startsWith("/") ? out : `${repo}/${out}`);
  }
  return gitDirCache.get(repo);
}

/** A file out of a ref's tip tree, or null when the ref or the file is absent. */
function readFile(repo, ref, path) {
  try {
    return git(repo, ["show", `${ref}:${path}`]);
  } catch {
    return null;
  }
}

/**
 * The two namespaces a forum can live in.
 *
 * `refs/h5i/forum/*` is what h5i uses locally and what `h5i forum remote`
 * publishes by default. `refs/heads/h5i-forum/*` is what `--branch-refs`
 * publishes, and it is the only one of the two a GitHub checkout can see —
 * `refs/h5i/*` is outside every default refspec, so an `actions/checkout` never
 * has it. A demo published to a forge is therefore always the branch one.
 *
 * Mirrors: forum_sync::NS_CUSTOM / NS_BRANCH.
 */
export const NAMESPACES = {
  branch: { meta: "refs/heads/h5i-forum/meta", threads: "refs/heads/h5i-forum/threads/" },
  custom: { meta: "refs/h5i/forum/meta", threads: "refs/h5i/forum/threads/" },
};

/** Which namespace this repository actually holds threads in. */
export function detectNamespace(repo, want = "auto") {
  if (want !== "auto") {
    if (!NAMESPACES[want]) throw new Error(`unknown namespace ${want}`);
    return want;
  }
  for (const name of ["branch", "custom"]) {
    if (listThreadRefs(repo, NAMESPACES[name]).length > 0) return name;
  }
  // Nothing either way: report the branch one, so an empty forum still renders
  // as an empty forum rather than as an error about which refs were missing.
  return "branch";
}

function listThreadRefs(repo, ns) {
  const out = git(repo, [
    "for-each-ref",
    "--format=%(refname) %(objectname)",
    `${ns.threads}*`,
  ]).trim();
  if (!out) return [];
  return out
    .split("\n")
    .map((line) => {
      const [refname, oid] = line.split(" ");
      return { ref: refname, oid, id: refname.slice(ns.threads.length) };
    })
    // Ids reach file paths in the published snapshot, so they are validated
    // rather than escaped — the same rule `forum::validate_thread_id` applies
    // before an id reaches a ref name.
    .filter((t) => validThreadId(t.id));
}

/** Mirrors: forum::validate_thread_id. */
export function validThreadId(id) {
  return /^[0-9a-f]{16}$/.test(id);
}

// ── reading ──────────────────────────────────────────────────────────────────

/**
 * Every thread in the repository, parsed but not yet projected.
 *
 * Mirrors: forum::read_thread_at, over the ref enumeration in
 * forum::list_threads_in.
 */
export function readThreads(repo, nsName) {
  const ns = NAMESPACES[nsName];
  const out = [];
  for (const t of listThreadRefs(repo, ns)) {
    const raw = readFile(repo, t.oid, "thread.json");
    if (!raw) continue; // no header is not a thread
    let header;
    try {
      header = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!header || header.id !== t.id) continue;
    out.push({
      header,
      posts: parsePosts(readFile(repo, t.oid, "posts.jsonl") ?? ""),
      tip: t.oid,
    });
  }
  return out;
}

/**
 * Mirrors: forum::parse_posts — blank and malformed lines are skipped so one
 * bad line from a future build does not make a thread unreadable.
 *
 * The file order is kept. h5i writes and merges `posts.jsonl` in `(ts, id)`
 * order, so re-sorting here would be a second opinion about an order that is
 * already settled — and a wrong one for a post whose `ts` a peer's clock skewed.
 */
function parsePosts(content) {
  const out = [];
  for (const line of content.split("\n")) {
    const l = line.trim();
    if (!l) continue;
    try {
      const p = JSON.parse(l);
      if (p && typeof p.id === "string" && typeof p.kind === "string") out.push(p);
    } catch {
      /* skip */
    }
  }
  return out;
}

/** Mirrors: forum::read_roster. Absent roster is an empty one, not an error. */
export function readRoster(repo, nsName) {
  const raw = readFile(repo, NAMESPACES[nsName].meta, "roster.json");
  if (!raw) return [];
  try {
    const roster = JSON.parse(raw);
    // Stored as a map keyed by a name that is already inside each entry; the
    // API hands out an array, as `h5i forum status --json` does.
    return Object.values(roster.agents ?? {});
  } catch {
    return [];
  }
}

// ── the projection ───────────────────────────────────────────────────────────

const KIND_TASK = "TASK";
const KIND_CLAIM = "CLAIM";
const KIND_REVIEW_REQUEST = "REVIEW_REQUEST";
const KIND_DONE = "DONE";
const KIND_BLOCKED = "BLOCKED";
const KIND_CLOSED = "CLOSED";
const KIND_UPVOTE = "UPVOTE";
const KIND_DOWNVOTE = "DOWNVOTE";

const isVote = (p) => p.kind === KIND_UPVOTE || p.kind === KIND_DOWNVOTE;
const isDenied = (p) => p.denied != null;

/**
 * Where a thread has got to. Never stored — walked from the posts, so the last
 * thing that happened wins and a `DONE` followed by a re-`CLAIM` is claimed
 * again.
 *
 * The close is the one status that does not follow last-writer-wins, and the
 * reason is worth keeping in this port: posts are ordered by `(ts, id)`, so a
 * post that merely *sorts* after a close — one that arrived late from a peer,
 * or one written while the closing host's clock ran ahead — would silently
 * reopen a thread nobody reopened. Only a human taking a status-moving action
 * counts.
 *
 * Mirrors: forum::Thread::status.
 */
export function status(posts) {
  let s = "open";
  let closed = false;
  for (const p of posts) {
    if (isDenied(p)) continue; // a refused post moves nothing
    if (isVote(p)) continue; // agreeing with a post is not a move in the thread
    if (p.kind === KIND_CLOSED) {
      closed = true;
      continue;
    }
    if (closed) {
      const reopening =
        p.role === "human" &&
        [KIND_CLAIM, KIND_REVIEW_REQUEST, KIND_DONE, KIND_BLOCKED].includes(p.kind);
      if (!reopening) continue;
      closed = false;
    }
    if (p.kind === KIND_CLAIM) s = "claimed";
    else if (p.kind === KIND_REVIEW_REQUEST) s = "review";
    else if (p.kind === KIND_DONE) s = "done";
    else if (p.kind === KIND_BLOCKED) s = "blocked";
  }
  return closed ? "closed" : s;
}

/**
 * Net score of one post: agreements minus disagreements, one vote per
 * participant with the last one winning.
 *
 * Mirrors: forum::Thread::score_of.
 */
export function scoreOf(posts, postId) {
  const byVoter = new Map();
  for (const p of posts) {
    if (isDenied(p) || p.reply_to !== postId) continue;
    if (p.kind === KIND_UPVOTE) byVoter.set(p.sender, 1);
    else if (p.kind === KIND_DOWNVOTE) byVoter.set(p.sender, -1);
  }
  let sum = 0;
  for (const v of byVoter.values()) sum += v;
  return sum;
}

/** Mirrors: forum::Thread::conversation — the posts that are not votes. */
export const conversation = (posts) => posts.filter((p) => !isVote(p));

/** Mirrors: forum::Thread::opening — the first accepted TASK. */
export const opening = (posts) =>
  posts.find((p) => p.kind === KIND_TASK && !isDenied(p)) ?? null;

/** Mirrors: forum::Thread::replies — the conversation without its opening. */
export function replies(posts) {
  const open = opening(posts);
  return conversation(posts).filter((p) => p !== open);
}

/**
 * Mirrors: forum::Thread::top_score — the best score any single post reached.
 * A sum would reward length; a thread is worth what its best post is worth.
 */
export function topScore(posts) {
  const scores = conversation(posts).map((p) => scoreOf(posts, p.id));
  return scores.length ? Math.max(...scores) : 0;
}

/** Mirrors: forum::Thread::claimed_by — the most recent accepted CLAIM. */
export function claimedBy(posts) {
  for (let i = posts.length - 1; i >= 0; i--) {
    const p = posts[i];
    if (p.kind === KIND_CLAIM && !isDenied(p)) return p.sender;
  }
  return null;
}

/** Mirrors: forum::Thread::participants — distinct senders, first-post order. */
export function participants(posts) {
  const seen = [];
  for (const p of posts) if (!seen.includes(p.sender)) seen.push(p.sender);
  return seen;
}

/** Mirrors: forum::Thread::last_activity. */
export const lastActivity = (t) =>
  t.posts.length ? t.posts[t.posts.length - 1].ts : t.header.created_at;

/** Mirrors: forum::summarize. */
export function summarize(t) {
  const by = claimedBy(t.posts);
  // Field order matches the Rust struct's, because `check-projection.mjs`
  // diffs this against what the live API serves.
  return {
    header: t.header,
    status: status(t.posts),
    ...(by != null ? { claimed_by: by } : {}),
    posts: t.posts.length,
    last_activity: lastActivity(t),
    denials: t.posts.filter(isDenied).length,
  };
}

/** Newest activity first, id breaking ties. Mirrors: forum::list_threads_in. */
export const byActivity = (a, b) =>
  b.last_activity.localeCompare(a.last_activity) || a.header.id.localeCompare(b.header.id);

// ── rendering-safe text ──────────────────────────────────────────────────────

// Bidi formatting characters reorder the text *around* them, and Rust's
// `char::is_control` is false for every one of them, so they need their own
// pass. The zero-width joiner and non-joiner (U+200C, U+200D) are deliberately
// absent: same Unicode category, no reordering power, and they are what holds a
// multi-part emoji together.
const BIDI = /[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;
// What Rust's `char::is_control` matches: C0, DEL, and C1. `\t`, `\n` and `\r`
// are folded to spaces before this runs rather than dropped by it.
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/g;

/**
 * Make an untrusted string safe to show, folding its line breaks into spaces.
 *
 * Mirrors: h5i_error::redact::sanitize_display.
 */
export function sanitizeDisplay(s) {
  return String(s ?? "")
    .replace(/[\t\n\r]/g, " ")
    .replace(CONTROL, "")
    .replace(BIDI, "");
}

/**
 * `sanitizeDisplay` for text that is meant to have lines. A `\r` inside a line
 * still becomes a space: return-to-column-zero is how one line overwrites what
 * was printed before it, which is the same spoof with none of the escape.
 *
 * Mirrors: h5i_error::redact::sanitize_block.
 */
export const sanitizeBlock = (s) =>
  String(s ?? "")
    .split("\n")
    .map(sanitizeDisplay)
    .join("\n");

/** Rust's `chars().take(n)`: Unicode scalars, not UTF-16 code units. */
export const takeChars = (s, n) => [...s].slice(0, n).join("");
