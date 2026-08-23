// Where the snapshot comes from.
//
// There is one copy now, and it is the one that shipped with the page: the
// `api/` directory `tools/snapshot.mjs` wrote into the build. It is always
// present, never fails, and asks a forge for nothing — and it is exactly as
// old as the last Pages deploy.
//
// ── why the page does not update on its own ──────────────────────────────────
//
// It used to. An earlier version polled a `forum-state` branch from every
// reader's browser, so an open tab moved to a newer snapshot on its own. That
// meant every viewer's browser sending conditional requests at `api.github.com`
// on a timer — well within the unauthenticated 60/hour budget, and cheap
// because a 304 does not count against it, but still the kind of unattended,
// fan-out traffic that is not worth the risk of being read as abuse.
//
// So freshness is a deploy now. `pages.yml` runs on a forum push (and on
// request), rebuilds this bundled copy, and redeploys. A reader with the tab
// already open sees the new posts on the next load — the refresh button below
// re-reads the bundled files from the Pages CDN, which is same-origin static
// content with no rate limit, and picks up a redeploy without a full reload.

/** Runtime configuration, from `public/config.json`. */
export interface ViewerConfig {
  /**
   * `owner/name` of the repository this page belongs to — used only for the
   * masthead's link back to the repository. `null` → derive it from the Pages
   * hostname; see `deriveRepo`.
   */
  repo: string | null;
}

/** `index.json` — what `tools/snapshot.mjs` writes. */
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

export interface SourceStatus {
  index: SnapshotIndex | null;
  /** epoch ms of the last completed read. */
  checkedAt: number | null;
  checking: boolean;
  /** Why the last read did not produce an answer. Shown, not swallowed. */
  error: string | null;
  /** The repository this page belongs to, for the masthead link. */
  repo: string | null;
}

type Listener = (s: SourceStatus) => void;

// ── the store ────────────────────────────────────────────────────────────────

class Snapshots {
  private status: SourceStatus = {
    index: null,
    checkedAt: null,
    checking: false,
    error: null,
    repo: null,
  };

  private listeners = new Set<Listener>();
  /** One in-flight promise per file. Cleared on `refresh`. */
  private files = new Map<string, Promise<unknown>>();
  private config: Promise<ViewerConfig> | null = null;
  private loading: Promise<void> | null = null;

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.status);
    return () => this.listeners.delete(fn);
  }

  current(): SourceStatus {
    return this.status;
  }

  /**
   * One snapshot file.
   *
   * Called by `ForumView` on its own 8s and 2s timers, so it must be cheap when
   * nothing has changed: the files are loaded once and served from a map after
   * that. The bundled copy cannot change under an open tab, so there is nothing
   * to revalidate between deploys — `refresh` is the only thing that re-reads.
   */
  async json<T>(path: string): Promise<T> {
    await this.ensureLoaded();
    return this.file<T>(path);
  }

  /**
   * One file, cached per path.
   *
   * A rejected promise is evicted so a transient failure does not poison every
   * later call — including after the network came back.
   */
  private file<T>(path: string): Promise<T> {
    const hit = this.files.get(path) as Promise<T> | undefined;
    if (hit) return hit;
    const pending = this.fetchBundled<T>(path);
    pending.catch(() => {
      if (this.files.get(path) === pending) this.files.delete(path);
    });
    this.files.set(path, pending as Promise<unknown>);
    return pending;
  }

  /** Re-read from the Pages CDN — picks up a redeploy without a full reload. */
  async refresh(): Promise<void> {
    this.files.clear();
    await this.load();
  }

  private ensureLoaded(): Promise<void> {
    if (this.status.index) return Promise.resolve();
    return this.load();
  }

  private load(): Promise<void> {
    if (this.loading) return this.loading;
    this.loading = this.read().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  private async read(): Promise<void> {
    const cfg = await this.loadConfig();
    this.emit({ checking: true, repo: cfg.repo });
    try {
      const index = await this.file<SnapshotIndex>("index.json");
      // A moved snapshot invalidates the per-file cache; on a plain first load
      // there is nothing to clear, so this only bites after a `refresh`.
      if (index.state !== this.status.index?.state) {
        this.files.clear();
        this.files.set("index.json", Promise.resolve(index));
      }
      this.emit({ index, checkedAt: Date.now(), checking: false, error: null });
    } catch (e) {
      this.emit({ checking: false, checkedAt: Date.now(), error: message(e) });
    }
  }

  private async fetchBundled<T>(path: string): Promise<T> {
    // The bundled copy is addressed by a path that is rewritten on every
    // deploy, so it has to be revalidated rather than served from the browser
    // cache — that is what lets `refresh` pull a redeploy into an open tab.
    const url = `${import.meta.env.BASE_URL}api/${path}`;
    const res = await fetch(url, { cache: "no-cache" });
    if (!res.ok) throw new Error(`${path}: ${res.status} ${res.statusText}`);
    return (await res.json()) as T;
  }

  private loadConfig(): Promise<ViewerConfig> {
    if (!this.config) {
      this.config = fetch(`${import.meta.env.BASE_URL}config.json`, { cache: "no-cache" })
        .then((r) => (r.ok ? r.json() : {}))
        .catch(() => ({}))
        .then((raw) => {
          const repo = (raw as Partial<ViewerConfig>).repo;
          return { repo: repo && REPO_RE.test(repo) ? repo : deriveRepo() };
        });
    }
    return this.config;
  }

  private emit(patch: Partial<SourceStatus>): void {
    this.status = { ...this.status, ...patch };
    for (const fn of this.listeners) fn(this.status);
  }
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ── configuration ────────────────────────────────────────────────────────────

const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/**
 * The repository this page is served from, read off the Pages URL.
 *
 * `owner.github.io/repo/` is a project site; `owner.github.io/` is the user
 * site, whose repository is named after the host. A custom domain carries
 * neither, so it returns null and the masthead simply omits the link until
 * `config.json` names the repository.
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
