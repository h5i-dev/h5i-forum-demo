// Where the snapshot comes from, and how often it is worth asking again.
//
// There are two places this page can read a forum from, and it uses both.
//
//   bundled  The `api/` directory that shipped with the page. Always present,
//            never fails, never rate-limited — and exactly as old as the last
//            Pages deploy.
//
//   live     The same files on a branch of the repository, fetched at an
//            immutable commit sha. Updated by the workflow that runs on every
//            forum push, with no site rebuild in between, so it is minutes
//            fresher than the bundled copy and usually seconds.
//
// The page paints from the bundled copy immediately and then moves to the live
// one if there is a newer commit. A viewer never waits on the network to see
// something, and never sees nothing because a forge said no.
//
// ── why this is not a websocket ──────────────────────────────────────────────
//
// GitHub Pages serves static files. There is no server here to hold a
// connection open, so "live" means polling, and polling a public API from every
// reader's browser is how you get an IP rate-limited: 60 requests per hour
// unauthenticated, shared by everything else that origin does.
//
// Two things make it work anyway.
//
// **Conditional requests.** The poll sends `If-None-Match` with the last ETag,
// and GitHub answers 304 when the branch has not moved. A 304 does not count
// against the rate limit. So an idle forum costs nothing at all, and the budget
// is spent only on polls that actually found something — which is the shape you
// want, because those are the ones a reader is waiting for.
//
// **Content at an immutable sha.** Once the poll reports a new commit, the JSON
// is fetched from `raw.githubusercontent.com` at that sha, which is a CDN path
// with no API rate limit and content that can be cached forever because it
// cannot change.
//
// The rest is arithmetic: one conditional request per interval, ~1 KB of JSON
// per actual change, and `ForumView`'s own 8s and 2s pollers served from a
// cache in between so they cost nothing.

/** Defaults, overridable by `public/config.json` and then by the query string. */
export interface ViewerConfig {
  /** `owner/name` of the repository holding the snapshot branch. */
  repo: string | null;
  /** Branch the snapshot workflow writes to. */
  branch: string;
  /** Directory within that branch. */
  path: string;
  /** Seconds between checks for a newer snapshot. */
  pollSeconds: number;
  /** Whether to check at all. Off means bundled-only. */
  live: boolean;
}

/**
 * The query string as it was when the page loaded.
 *
 * Captured here rather than read on demand, because the vendored `ForumView`
 * rewrites the address bar to `pathname + #forum/<id>` as soon as it mounts —
 * in h5i that is how a one-time token stops being in the URL, and it is right
 * there — and the rewrite takes the search string with it. `main.tsx` puts it
 * back for the reader's sake; this makes the config independent of whether that
 * won the race.
 */
const QUERY = new URLSearchParams(window.location.search);

const DEFAULTS: ViewerConfig = {
  repo: null, // null → derived from the Pages hostname; see `deriveRepo`
  branch: "forum-state",
  path: "api",
  pollSeconds: 45,
  live: true,
};

/** `index.json` — what `tools/snapshot.mjs` writes for a poller to read. */
export interface SnapshotIndex {
  version: number;
  /** Digest over every thread's ref tip: moves when and only when the forum did. */
  state: string;
  namespace: string;
  demo: boolean;
  source: { repo: string | null; branch: string | null };
  latest_activity: string | null;
  counts: { threads: number; closed: number; posts: number; participants: number };
  threads: { id: string; tip: string }[];
}

/** Which of the two copies the page is currently showing. */
export type Where =
  | { kind: "bundled" }
  | { kind: "live"; sha: string; at: string | null };

export interface SourceStatus {
  where: Where;
  index: SnapshotIndex | null;
  /** epoch ms of the last completed check, live or bundled. */
  checkedAt: number | null;
  checking: boolean;
  /** Why the last check did not produce an answer. Shown, not swallowed. */
  error: string | null;
  /** epoch ms the forge asked us to wait until, when it rate-limited us. */
  cooldownUntil: number | null;
  /** Whether a live source is configured at all. */
  live: boolean;
  config: ViewerConfig | null;
}

type Listener = (s: SourceStatus) => void;

// ── the store ────────────────────────────────────────────────────────────────

class Snapshots {
  private status: SourceStatus = {
    where: { kind: "bundled" },
    index: null,
    checkedAt: null,
    checking: false,
    error: null,
    cooldownUntil: null,
    live: false,
    config: null,
  };

  private listeners = new Set<Listener>();
  /** One in-flight promise per file per origin. Cleared when the origin moves. */
  private files = new Map<string, Promise<unknown>>();
  private config: Promise<ViewerConfig> | null = null;
  private nextCheckAt = 0;
  private checking: Promise<void> | null = null;
  private etag: string | null = null;

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.status);
    return () => this.listeners.delete(fn);
  }

  current(): SourceStatus {
    return this.status;
  }

  /**
   * One snapshot file, from whichever copy is current.
   *
   * Called by `ForumView` on its own timers, so it must be cheap when nothing
   * has changed: the revalidation below is throttled to the poll interval, and
   * everything after it is a map lookup.
   */
  async json<T>(path: string): Promise<T> {
    await this.revalidate();
    return this.file(this.status.where, path);
  }

  /**
   * One file from one copy, cached per (copy, path).
   *
   * Separate from `json` because the revalidation below calls it, and a
   * revalidation that waited on the revalidation it is part of would never
   * finish. Nothing outside this class should use it.
   */
  private file<T>(where: Where, path: string): Promise<T> {
    const key = `${originKey(where)}|${path}`;
    const hit = this.files.get(key) as Promise<T> | undefined;
    if (hit) return hit;
    const pending = this.fetchFrom<T>(where, path);
    // A rejected promise left in the map would fail every later call with a
    // stale error, including after the network came back.
    pending.catch(() => {
      if (this.files.get(key) === pending) this.files.delete(key);
    });
    this.files.set(key, pending as Promise<unknown>);
    return pending;
  }

  /** Ask now, whatever the timer says — the refresh button. */
  async refresh(): Promise<void> {
    this.nextCheckAt = 0;
    this.emit({ cooldownUntil: null });
    await this.revalidate();
  }

  private async revalidate(): Promise<void> {
    if (this.checking) return this.checking;
    const now = Date.now();
    if (now < this.nextCheckAt) return;
    if (this.status.cooldownUntil && now < this.status.cooldownUntil) return;

    this.checking = this.check().finally(() => {
      this.checking = null;
    });
    return this.checking;
  }

  private async check(): Promise<void> {
    const cfg = await this.loadConfig();
    this.nextCheckAt = Date.now() + cfg.pollSeconds * 1000;
    this.emit({ checking: true, live: cfg.live && cfg.repo !== null, config: cfg });

    // Two independent questions, and the second must be answered even when the
    // first goes wrong: "is there a newer copy" can fail without making "what
    // does the copy I have say" unanswerable. Folding them into one try block
    // is what once left the masthead blank — no counts, no timestamp — on a
    // page that was rendering the bundled forum perfectly well underneath it.
    let where: Where = { kind: "bundled" };
    let note: string | null = null;

    if (cfg.live && cfg.repo) {
      try {
        where = await this.probeLive(cfg);
      } catch (e) {
        note = message(e);
      }
    }

    try {
      let index: SnapshotIndex;
      try {
        index = await this.file<SnapshotIndex>(where, "index.json");
      } catch (e) {
        // The branch is there and does not hold a snapshot where `config.json`
        // says it does. That is a misconfiguration, not a reason to show an
        // empty page when a good bundled copy is sitting right here — but it is
        // said out loud, because a viewer silently showing the older of two
        // copies is the failure you never find.
        if (where.kind !== "live") throw e;
        note = `${cfg.branch} holds no ${cfg.path}/index.json — showing the copy that shipped with the page`;
        // Forget the ETag, or every later poll takes the 304 path, returns the
        // copy in use — this one — and the viewer never notices the branch
        // getting its first snapshot. A conditional request is only a saving
        // when the answer it caches is one we are still using.
        this.etag = null;
        where = { kind: "bundled" };
        index = await this.file<SnapshotIndex>(where, "index.json");
      }

      if (originKey(where) !== originKey(this.status.where) || index.state !== this.status.index?.state) {
        this.files.clear();
        // `index.json` was just fetched and is still good; keeping it saves a
        // request on the call that follows immediately.
        this.files.set(`${originKey(where)}|index.json`, Promise.resolve(index));
      }
      this.emit({ where, index, checkedAt: Date.now(), checking: false, error: note });
    } catch (e) {
      this.emit({ where, checking: false, checkedAt: Date.now(), error: note ?? message(e) });
    }
  }

  /**
   * Has the snapshot branch moved? Returns where to read from now.
   *
   * Falls back to the bundled copy for anything short of a clear answer — a
   * missing branch, a rate limit, an offline reader — because a stale page that
   * says how stale it is beats an empty one that says why.
   */
  private async probeLive(cfg: ViewerConfig): Promise<Where> {
    const url = `https://api.github.com/repos/${cfg.repo}/commits/${encodeURIComponent(cfg.branch)}`;
    const res = await fetch(url, {
      // `no-store` keeps the browser's own cache from answering, so the
      // conditional header below is the only thing deciding 200 versus 304.
      cache: "no-store",
      headers: {
        Accept: "application/vnd.github+json",
        ...(this.etag ? { "If-None-Match": this.etag } : {}),
      },
    });

    if (res.status === 304) return this.status.where; // unchanged, and it cost nothing

    if (res.status === 403 || res.status === 429) {
      // Believe the forge's own reset time rather than guessing, but never wait
      // more than an hour on a header we do not control.
      const reset = Number(res.headers.get("x-ratelimit-reset")) * 1000;
      const until = Number.isFinite(reset) && reset > Date.now() ? reset : Date.now() + 15 * 60_000;
      this.emit({ cooldownUntil: Math.min(until, Date.now() + 3_600_000) });
      throw new Error("GitHub rate-limited this browser — showing the copy that shipped with the page");
    }
    // No snapshot branch yet. Not an error worth a red line: it is what a
    // repository looks like before the publishing workflow has ever run.
    //
    // Both codes, because this endpoint answers 422 ("No commit found for SHA")
    // for a ref that does not exist and 404 only for a repository that does
    // not. Treating 422 as a failure is what made a freshly deployed site
    // report "live check failed" when nothing had failed and nothing was wrong.
    if (res.status === 404 || res.status === 422) return { kind: "bundled" };
    if (!res.ok) throw new Error(`GitHub answered ${res.status} ${res.statusText}`);

    this.etag = res.headers.get("etag");
    const body = (await res.json()) as {
      sha?: string;
      commit?: { committer?: { date?: string } };
    };
    if (!body.sha || !/^[0-9a-f]{40}$/.test(body.sha)) return { kind: "bundled" };
    return { kind: "live", sha: body.sha, at: body.commit?.committer?.date ?? null };
  }

  private async fetchFrom<T>(where: Where, path: string): Promise<T> {
    const cfg = await this.loadConfig();
    const url =
      where.kind === "live"
        ? `https://raw.githubusercontent.com/${cfg.repo}/${where.sha}/${cfg.path}/${path}`
        : `${import.meta.env.BASE_URL}api/${path}`;
    const res = await fetch(url, {
      // Live content is addressed by sha and can never change, so let the CDN
      // and the browser keep it. The bundled copy is addressed by a path that
      // is rewritten on every deploy, so it has to be revalidated.
      cache: where.kind === "live" ? "force-cache" : "no-cache",
    });
    if (!res.ok) throw new Error(`${path}: ${res.status} ${res.statusText}`);
    return (await res.json()) as T;
  }

  private loadConfig(): Promise<ViewerConfig> {
    if (!this.config) {
      this.config = fetch(`${import.meta.env.BASE_URL}config.json`, { cache: "no-cache" })
        .then((r) => (r.ok ? r.json() : {}))
        .catch(() => ({}))
        .then((raw) => withOverrides({ ...DEFAULTS, ...(raw as Partial<ViewerConfig>) }));
    }
    return this.config;
  }

  private emit(patch: Partial<SourceStatus>): void {
    this.status = { ...this.status, ...patch };
    for (const fn of this.listeners) fn(this.status);
  }
}

const originKey = (w: Where) => (w.kind === "live" ? `live:${w.sha}` : "bundled");

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ── configuration ────────────────────────────────────────────────────────────

// Both are ref and path components that end up in a URL, so they are validated
// rather than escaped — the same rule the snapshot tool applies to thread ids.
const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const BRANCH_RE = /^[A-Za-z0-9._\-/]+$/;

/**
 * Query-string overrides, so one deployed viewer can be pointed at another
 * public forum without a rebuild — `?repo=owner/name&branch=forum-state`.
 *
 * Safe to accept from a stranger's link: everything it can reach is public
 * unauthenticated content, the page holds no credential to leak to it, and both
 * values are checked against a charset before they reach a URL. `?live=0` is
 * the escape hatch when the bundled copy is the one you want to look at.
 */
function withOverrides(cfg: ViewerConfig): ViewerConfig {
  const q = QUERY;
  const repo = q.get("repo");
  const branch = q.get("branch");
  const live = q.get("live");
  return {
    ...cfg,
    repo: repo && REPO_RE.test(repo) ? repo : (cfg.repo ?? deriveRepo()),
    branch: branch && BRANCH_RE.test(branch) && !branch.includes("..") ? branch : cfg.branch,
    live: live === null ? cfg.live : live !== "0" && live !== "false",
    pollSeconds: Math.max(15, Number(cfg.pollSeconds) || DEFAULTS.pollSeconds),
  };
}

/**
 * The repository this page is served from, read off the Pages URL.
 *
 * `owner.github.io/repo/` is a project site; `owner.github.io/` is the user
 * site, whose repository is named after the host. A custom domain carries
 * neither, so it returns null and the live source stays off until `config.json`
 * names the repository — guessing there would send every reader's browser at
 * some unrelated repository.
 */
function deriveRepo(): string | null {
  const host = window.location.hostname;
  const m = /^([A-Za-z0-9-]+)\.github\.io$/.exec(host);
  if (!m) return null;
  const owner = m[1];
  const first = window.location.pathname.split("/").filter(Boolean)[0];
  const repo = first ?? `${owner}.github.io`;
  const full = `${owner}/${repo}`;
  return REPO_RE.test(full) ? full : null;
}

export const snapshots = new Snapshots();
