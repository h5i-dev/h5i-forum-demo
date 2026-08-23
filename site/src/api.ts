// What the vendored `ForumView.tsx` consumes.
//
// In h5i this file talks to a Rust server over loopback. Here it talks to a
// directory of JSON that `tools/snapshot.mjs` wrote out of a git repository —
// the same two shapes, so the view does not know the difference and does not
// have to. Everything that makes a *public* viewer different from the host's
// own console is decided in the snapshot rather than here: `origin: ""` so no
// post can render as host-observed, and `influenced: []` so a fact about a
// machine's spool is not guessed at from a repository.
//
// The types below are mirrors of `h5i_core::forum` and `h5i_core::server`,
// copied from `web/src/api.ts` @ 9050e3c75 with the console's own routes
// dropped. They are the contract the snapshot has to satisfy.

import { snapshots } from "./source";

/** `h5i_core::forum::Ceiling` — the profile every participant must be under. */
export interface ForumCeiling {
  profile: string;
  digest?: string;
}

/** `h5i_core::forum::ThreadHeader` — what is fixed when a thread is opened. */
export interface ForumThreadHeader {
  id: string;
  title: string;
  created_at: string;
  created_by: string;
  version: number;
  ceiling?: ForumCeiling;
  branch?: string;
}

export type ForumStatus =
  | "open"
  | "claimed"
  | "review"
  | "done"
  | "blocked"
  | "closed";

/** `h5i_core::forum::Attachment` — content-addressed, kind from an allowlist. */
export interface ForumAttachment {
  kind: string;
  digest: string;
  size: number;
  name?: string;
}

/**
 * `h5i_core::forum::Post`.
 *
 * The split that the UI has to render, and the reason this file names it: the
 * agent chose `kind`, `body` and `attachments`; the host stamped `sender`,
 * `box_id`, `role`, `policy_digest` and `denied`. One half is a claim and the
 * other is an observation, and a reader who cannot tell them apart is reading
 * the forum wrong.
 *
 * On this surface the second half is a claim too — a different host's, relayed
 * by a git repository. That is what `origin` not matching is for.
 */
export interface ForumPost {
  id: string;
  ts: string;
  thread: string;
  version: number;
  kind: string;
  body: string;
  reply_to?: string;
  attachments?: ForumAttachment[];
  sender: string;
  box_id?: string;
  role: string;
  policy_digest?: string;
  denied?: string;
  /** Secret-detector rules that fired; the credential itself never landed. */
  redactions?: string[];
  /**
   * Which host stamped this. Attribution, not authentication — nothing signs
   * it. The only sound comparison is against the reading host's own origin,
   * which for this viewer is the empty string, on purpose.
   */
  origin?: string;
}

/** `h5i_core::forum::ThreadSummary` — a thread without its posts. */
export interface ForumThreadSummary {
  header: ForumThreadHeader;
  status: ForumStatus;
  claimed_by?: string;
  posts: number;
  last_activity: string;
  denials: number;
}

/** `h5i_core::forum::RosterEntry` — membership, host-authored. */
export interface ForumRosterEntry {
  agent: string;
  box_id?: string;
  role: "worker" | "reviewer" | "observer" | "human";
  policy_digest?: string;
  attached_at: string;
  revoked_at?: string;
}

/** `h5i_core::server::ForumPreview` — enough of a thread to rank it. */
export interface ForumPreview {
  thread: string;
  /** The thread's own opening post, when the human wrote one. */
  opening: string;
  top_score: number;
  /** The best-scored *reply*, if any reply has a positive score. */
  top_body: string;
  top_sender: string;
  voices: string[];
}

/** `h5i_core::server::ForumView` — `GET /api/forum`. */
export interface ForumOverview {
  threads: ForumThreadSummary[];
  closed: ForumThreadSummary[];
  roster: ForumRosterEntry[];
  /** Always empty here: not a fact a repository carries. */
  influenced: string[];
  previews: ForumPreview[];
}

/** `h5i_core::server::ForumThreadView` — `GET /api/forum/thread/:id`. */
export interface ForumThread {
  header: ForumThreadHeader;
  status: ForumStatus;
  claimed_by?: string;
  posts: ForumPost[];
  /** The reading host's own identity. Empty here — this page stamped nothing. */
  origin: string;
  /** Net score per post id, projected at snapshot time so there is one definition. */
  scores: Record<string, number>;
}

/**
 * The two routes, against a snapshot instead of a server.
 *
 * `ForumView` polls these on 8s and 2s timers, which is the right cadence
 * against loopback and would be a way to get an IP rate-limited against a
 * forge. `snapshots` is what makes the cadence affordable: a call here is a
 * cache read, and the network is touched only when the poller decides a check
 * is due. See `source.ts`.
 */
export const forumApi = {
  overview: () => snapshots.json<ForumOverview>("forum.json"),
  thread: (id: string) =>
    snapshots.json<ForumThread>(`thread/${encodeURIComponent(id)}.json`),
};
