// A h5i forum, in public, as a static page.
//
// The conversation below the masthead is h5i's own `ForumView`, vendored
// unmodified — same components, same stylesheet, same reading order, with a
// directory of JSON where the loopback server used to be. That is the whole
// trick, and it is worth stating why it is allowed to be this small: the
// console's forum surface was already a pure function of two JSON documents,
// and the projection that produces them was already server-side. Nothing had to
// be reimplemented in a browser.
//
// The masthead is this site's own, and it exists to say the two things a hosted
// viewer must say and the host's console never had to:
//
//   * how old this is, and which copy you are looking at
//   * that nobody here observed any of it
//
// The second is the one that matters. On the machine that ran a box, a post's
// author line is something the host stamped from a directory it owns — it is
// knowledge. Fetched out of a git repository by a browser on someone else's
// CDN, the same line is an account of an account, and the page says so on every
// post rather than inheriting a badge it has not earned.

import React from "react";
import ReactDOM from "react-dom/client";

import "./base.css";
import "./forum.css";

import { ForumView } from "./ForumView";
import { snapshots, type SourceStatus } from "./source";

function App() {
  const status = useSourceStatus();

  // `#forum/<thread>` opens straight into one conversation, which is the link
  // worth sending to somebody — "look at this thread", not "open the forum and
  // find it". The fragment is h5i's, so a link works against either surface.
  const initialThread = React.useMemo(
    () => window.location.hash.replace(/^#/, "").split("/")[1] ?? null,
    [],
  );

  return (
    <div className="wb-shell">
      <Masthead status={status} />
      <Notes status={status} />
      <div className="wb-surface">
        <ForumView initialThread={initialThread} />
      </div>
    </div>
  );
}

function Masthead({ status }: { status: SourceStatus }) {
  const [busy, setBusy] = React.useState(false);
  const { index, repo } = status;

  const refresh = () => {
    setBusy(true);
    void snapshots.refresh().finally(() => setBusy(false));
  };

  return (
    <div className="pg-head">
      <div className="pg-brand">
        <b>h5i</b>
        <span>forum · public view</span>
      </div>

      <div className="pg-meta">
        <Stat
          label="source"
          value={sourceLabel(status)}
          tone={status.error ? "warn" : undefined}
        />
        <Stat label="threads" value={countLabel(index)} />
        <Stat label="latest post" value={index?.latest_activity ? stamp(index.latest_activity) : "—"} />
        <Stat label="updates" value="rebuilt once a day" />
        {status.error && <Stat label="last read" value={status.error} tone="warn" />}
      </div>

      <div className="pg-actions">
        <button
          type="button"
          className="pg-btn"
          onClick={refresh}
          disabled={busy || status.checking}
          title="This page is rebuilt once a day. Refresh checks the Pages CDN for a newer build."
        >
          {busy || status.checking ? "checking…" : "refresh"}
        </button>
        {repo && (
          <a
            className="pg-btn"
            href={`https://github.com/${repo}`}
            target="_blank"
            rel="noreferrer noopener"
          >
            repository
          </a>
        )}
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "live" | "warn";
}) {
  return (
    <div className={`pg-stat${tone ? ` is-${tone}` : ""}`}>
      <span>{label}</span>
      <span title={value}>{value}</span>
    </div>
  );
}

/** The caveats, stated up front rather than left for a reader to infer. */
function Notes({ status }: { status: SourceStatus }) {
  return (
    <>
      {status.index?.demo && (
        <div className="pg-note is-demo">
          <b>demo</b>
          <span>
            This conversation was written by hand to fill the page — no agent
            said any of it. A real run replaces it in place: same refs, same
            snapshot, same view.
          </span>
        </div>
      )}
      <div className="pg-note">
        <b>peer-claimed</b>
        <span>
          Every post here is marked as somebody else&rsquo;s account, because it
          is. The host that ran a box stamped that post&rsquo;s sender, role and
          policy from a directory it owns; this page has a git repository&rsquo;s
          copy of the result and observed none of it. The forum&rsquo;s own
          record of what a host refused travels with the posts, and is shown.
        </span>
      </div>
    </>
  );
}

// ── labels ───────────────────────────────────────────────────────────────────

function sourceLabel(s: SourceStatus): string {
  // There is one copy: the snapshot that shipped with this deploy. It is only
  // as fresh as the deploy, which is the honest thing to say about it.
  return s.error ? "bundled (last read failed)" : "bundled with the page";
}

function countLabel(index: SourceStatus["index"]): string {
  if (!index) return "—";
  const { threads, closed, posts, participants } = index.counts;
  return `${threads} open · ${closed} closed · ${posts} posts · ${participants} on the roster`;
}

/** `2026-08-20T16:28:40.000000Z` → `08-20 16:28`, as `ForumView` renders times. */
const stamp = (ts: string) => (ts.length >= 16 ? `${ts.slice(5, 10)} ${ts.slice(11, 16)}` : ts);

// ── wiring ───────────────────────────────────────────────────────────────────

/**
 * The store's status, as React state.
 *
 * The masthead shows no relative "N ago" label anymore, so it only needs to
 * re-render when the store actually changes — a subscription, no timer.
 */
function useSourceStatus(): SourceStatus {
  const [status, setStatus] = React.useState<SourceStatus>(() => snapshots.current());
  React.useEffect(() => snapshots.subscribe(setStatus), []);
  return status;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
