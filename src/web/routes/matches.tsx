/** @jsxImportSource hono/jsx */

/**
 * Match browsing (§7).
 *
 * Candidates are grouped into strong / plausible / weak buckets and ordered by
 * recency inside each bucket — deliberately not by score. The job is widening
 * the funnel of things worth reading, and every match shows its reasoning: the
 * exact passage that matched and which facet it matched against. Raw floats
 * stay on the tuning page.
 */

import { Hono } from "hono";
import type { FC } from "hono/jsx";
import { Layout } from "@web/layout.tsx";
import {
  CsrfField,
  Derived,
  formatDateTime,
  Notice,
  ProvenanceLine,
  relativeAge,
  Tabs,
} from "@web/components.tsx";
import type { AppEnv } from "@web/types.ts";
import { asFacetId, asPostingId, type FacetId, type PostingId } from "@platform/ids.ts";
import {
  bucketOf,
  type BucketThresholds,
  loadBucketThresholds,
  type MatchBucket,
  type MatchCandidate,
  type PostingChunkScore,
  type ProfileFacet,
} from "@domain/discovery/matching.ts";
import { CHUNKER_VERSION } from "@domain/discovery/chunk.ts";
import { embedPending } from "@domain/discovery/embed.ts";
import { scorePending } from "@domain/discovery/match.ts";
import type { Posting } from "@domain/discovery/types.ts";

/** One posting with its per-facet matches, led by the best of them. */
interface CandidateGroup {
  readonly best: MatchCandidate;
  readonly all: readonly MatchCandidate[];
}

function groupByPosting(candidates: readonly MatchCandidate[]): CandidateGroup[] {
  const groups = new Map<PostingId, MatchCandidate[]>();
  for (const candidate of candidates) {
    const list = groups.get(candidate.postingId);
    if (list === undefined) groups.set(candidate.postingId, [candidate]);
    else list.push(candidate);
  }
  return [...groups.values()].map((all) => ({
    best: all.reduce((a, b) => (b.score > a.score ? b : a)),
    all,
  }));
}

const BucketChip: FC<{ bucket: MatchBucket; label?: string }> = (props) => {
  const cls = props.bucket === "strong" ? "ok" : props.bucket === "plausible" ? "warn" : "muted";
  return <span class={`chip ${cls}`}>{props.label ?? props.bucket}</span>;
};

const CandidateCard: FC<{ group: CandidateGroup; thresholds: BucketThresholds; now: Date }> = (
  { group, thresholds, now },
) => {
  const best = group.best;
  return (
    <article class="match-card">
      <div class="match-head">
        <div>
          <a class="posting-title" href={`/matches/${encodeURIComponent(best.postingId)}`}>
            {best.title}
          </a>
          <p class="meta-line">
            <span>{best.companyName}</span>
            {best.locationRaw !== "" && <span>{best.locationRaw}</span>}
            <span>first seen {relativeAge(best.firstSeenAt, now)}</span>
            {!best.currentlyListed && <span class="chip warn">no longer listed</span>}
          </p>
        </div>
        <div class="match-facets">
          {group.all.map((m) => (
            <Derived title={`Similarity bucket for the "${m.facetName}" facet`}>
              <BucketChip
                bucket={bucketOf(m.score, thresholds)}
                label={`${m.facetName}: ${bucketOf(m.score, thresholds)}`}
              />
            </Derived>
          ))}
        </div>
      </div>
      <blockquote class="match-quote" cite={best.postingId}>
        {best.matchedChunk}
      </blockquote>
      <p class="field-hint">
        Passage quoted verbatim from the posting; matched the{" "}
        <Derived>"{best.facetName}" facet</Derived>. As of {formatDateTime(best.fetchedAt)}.
      </p>
    </article>
  );
};

const MatchesPage: FC<{
  groups: readonly CandidateGroup[];
  thresholds: BucketThresholds;
  facets: readonly ProfileFacet[];
  facetFilter: FacetId | undefined;
  search: string;
  embedBacklog: number;
  embedderConfigured: boolean;
  csrfToken: string;
  now: Date;
  notice?: string;
  error?: string;
}> = (props) => {
  const byBucket = new Map<MatchBucket, CandidateGroup[]>([
    ["strong", []],
    ["plausible", []],
    ["weak", []],
  ]);
  for (const group of props.groups) {
    byBucket.get(bucketOf(group.best.score, props.thresholds))!.push(group);
  }
  const strong = byBucket.get("strong")!;
  const plausible = byBucket.get("plausible")!;
  const weak = byBucket.get("weak")!;

  return (
    <Layout title="Matches" current="matches" csrfToken={props.csrfToken}>
      <Tabs
        label="Matches sections"
        items={[
          { href: "/matches", label: "Matches", current: true },
          { href: "/postings", label: "All postings" },
          { href: "/tuning", label: "Tuning" },
        ]}
      />
      <div class="page-head">
        <div>
          <h1>Matches</h1>
          <p class="lede">
            Postings whose text resembles your profile, with the matching passage quoted. Buckets
            are set on the{" "}
            <a href="/tuning">tuning page</a>; nothing here is a verdict on candidacy.
          </p>
        </div>
        <form method="post" action="/matches/refresh">
          <CsrfField token={props.csrfToken} />
          <button type="submit" class="primary" disabled={!props.embedderConfigured}>
            Refresh matches
          </button>
        </form>
      </div>

      {props.error !== undefined && <Notice kind="error">{props.error}</Notice>}
      {props.notice !== undefined && <Notice kind="ok">{props.notice}</Notice>}
      {!props.embedderConfigured && (
        <Notice kind="warn">
          No embedding API key is configured (VOYAGE_API_KEY); matching cannot run.
        </Notice>
      )}
      {props.embedBacklog > 0 && (
        <Notice kind="warn">
          {props.embedBacklog} posting{props.embedBacklog === 1 ? " is" : "s are"}{" "}
          not embedded yet and absent from every list below. Refresh to work through the backlog.
        </Notice>
      )}

      {
        /*
        Searching matches was missing while /postings had it from M1, which
        made a long strong bucket hard to work through.
      */
      }
      <form method="get" action="/matches" class="row filter-row">
        <label for="match-search">Search</label>
        <input
          id="match-search"
          name="q"
          type="search"
          value={props.search}
          placeholder="Title, company or location"
        />
        {props.facets.length > 1 && (
          <>
            <label for="facet-filter">Facet</label>
            <select id="facet-filter" name="facet">
              <option value="">All facets</option>
              {props.facets.map((f) => (
                <option value={f.id} selected={props.facetFilter === f.id}>{f.name}</option>
              ))}
            </select>
          </>
        )}
        <button type="submit" class="quiet">Filter</button>
        {(props.search !== "" || props.facetFilter !== undefined) && (
          <a class="button quiet" href="/matches">Clear</a>
        )}
      </form>

      {props.search !== "" && (
        <p class="panel-note">
          Showing matches whose title, company or location contains “{props.search}”. Counts below
          are of what survived the filter, not of everything matched.
        </p>
      )}

      <section class="panel">
        <header>
          <h2>Strong</h2>
          <span class="chip ok">{strong.length}</span>
        </header>
        {strong.length === 0
          ? <p class="empty">Nothing in this bucket.</p>
          : strong.map((g) => (
            <CandidateCard group={g} thresholds={props.thresholds} now={props.now} />
          ))}
      </section>

      <section class="panel">
        <header>
          <h2>Plausible</h2>
          <span class="chip warn">{plausible.length}</span>
        </header>
        {plausible.length === 0
          ? <p class="empty">Nothing in this bucket.</p>
          : plausible.map((g) => (
            <CandidateCard group={g} thresholds={props.thresholds} now={props.now} />
          ))}
      </section>

      <section class="panel">
        <details>
          <summary>
            <h2>Weak ({weak.length})</h2>
          </summary>
          <p class="panel-note">
            Below the plausible threshold. Kept visible so the funnel's floor is inspectable, not
            because these merit reading first.
          </p>
          {weak.map((g) => (
            <CandidateCard
              group={g}
              thresholds={props.thresholds}
              now={props.now}
            />
          ))}
        </details>
      </section>
    </Layout>
  );
};

const MatchDetailPage: FC<{
  posting: Posting;
  companyName: string;
  matches: readonly MatchCandidate[];
  chunkScores: readonly PostingChunkScore[];
  thresholds: BucketThresholds;
  csrfToken: string;
}> = (props) => {
  const gaps = props.chunkScores.filter(
    (chunk) => chunk.bestScore !== null && bucketOf(chunk.bestScore, props.thresholds) === "weak",
  );
  const unscored = props.chunkScores.filter((chunk) => chunk.bestScore === null);

  return (
    <Layout title={props.posting.title} current="matches" csrfToken={props.csrfToken}>
      <div class="page-head">
        <div>
          <h1>{props.posting.title}</h1>
          <p class="meta-line">
            <span>{props.companyName}</span>
            {props.posting.locationRaw !== "" && <span>{props.posting.locationRaw}</span>}
            {!props.posting.currentlyListed && <span class="chip muted">no longer listed</span>}
          </p>
        </div>
        <div class="row">
          <a class="button quiet" href={`/postings/${encodeURIComponent(props.posting.id)}`}>
            Full posting
          </a>
          <a class="button quiet" href={props.posting.applyUrl} rel="noreferrer noopener">
            Apply page ↗
          </a>
          {/* One click from a match to a pre-populated draft (§9). */}
          <a
            class="button primary"
            href={`/applications/new?posting=${encodeURIComponent(props.posting.id)}`}
          >
            Track an application
          </a>
        </div>
      </div>

      <section class="panel">
        <header>
          <h2>Why this surfaced</h2>
        </header>
        {props.matches.length === 0
          ? <p class="empty">No facet has been scored against this posting yet.</p>
          : props.matches.map((m) => (
            <article class="match-card">
              <div class="match-head">
                <Derived title="Computed similarity bucket, not a statement by the source">
                  <BucketChip
                    bucket={bucketOf(m.score, props.thresholds)}
                    label={`${m.facetName}: ${bucketOf(m.score, props.thresholds)}`}
                  />
                </Derived>
                <span class="field-hint">scored {formatDateTime(m.scoredAt)}</span>
              </div>
              <blockquote class="match-quote">{m.matchedChunk}</blockquote>
            </article>
          ))}
      </section>

      <section class="panel">
        <header>
          <h2>Possible gaps</h2>
        </header>
        <p class="panel-note">
          Passages of this posting with no strong counterpart anywhere in the profile. A gap can
          mean a missing skill — or a skill the profile just does not mention in this vocabulary.
        </p>
        {gaps.length === 0
          ? (
            <p class="empty">
              {props.chunkScores.length === 0
                ? "This posting has not been embedded yet."
                : "Every part of this posting has at least plausible support in the profile."}
            </p>
          )
          : gaps.map((chunk) => (
            <blockquote key={chunk.seq} class="match-quote gap">{chunk.text}</blockquote>
          ))}
        {unscored.length > 0 && (
          <p class="field-hint">
            {unscored.length} passage{unscored.length === 1 ? "" : "s"} not scored yet.
          </p>
        )}
      </section>

      <section class="panel">
        <header>
          <h2>Provenance</h2>
        </header>
        <ProvenanceLine provenance={props.posting.provenance} />
      </section>
    </Layout>
  );
};

export const matchRoutes = new Hono<AppEnv>();

matchRoutes.get("/matches", async (c) => {
  const services = c.get("services");
  const model = services.embedder?.model;

  let facetFilter: FacetId | undefined;
  const rawFacet = c.req.query("facet") ?? "";
  if (rawFacet !== "") {
    try {
      facetFilter = asFacetId(rawFacet);
    } catch {
      facetFilter = undefined;
    }
  }

  const search = (c.req.query("q") ?? "").trim();

  const [candidates, thresholds, facets, backlog] = await Promise.all([
    services.matches.listCandidates(facetFilter !== undefined ? { facetId: facetFilter } : {}),
    loadBucketThresholds(services.settings),
    services.facets.list(),
    model !== undefined
      ? services.chunks.stalePostingCount(model, CHUNKER_VERSION)
      : Promise.resolve(0),
  ]);

  const notice = c.req.query("notice");
  const error = c.req.query("error");
  // Filtered here rather than in SQL: the candidate set is a single user's, the
  // page is not hot, and a repository method would have to reach into three
  // columns to say what one `includes` says here.
  const needle = search.toLowerCase();
  const filtered = search === ""
    ? candidates
    : candidates.filter((candidate) =>
      `${candidate.title} ${candidate.companyName} ${candidate.locationRaw}`
        .toLowerCase()
        .includes(needle)
    );

  return c.html(
    <MatchesPage
      groups={groupByPosting(filtered)}
      thresholds={thresholds}
      facets={facets.filter((f) => f.active)}
      facetFilter={facetFilter}
      search={search}
      embedBacklog={backlog}
      embedderConfigured={services.embedder !== null}
      csrfToken={c.get("csrfToken")}
      now={services.clock.now()}
      {...(notice !== undefined ? { notice } : {})}
      {...(error !== undefined ? { error } : {})}
    />,
  );
});

/** Drain the embed queue, then score stale pairs. The n8n endpoints reuse both (§12, M6). */
matchRoutes.post("/matches/refresh", async (c) => {
  const services = c.get("services");
  const logger = c.get("logger");
  if (services.embedder === null) {
    return c.redirect(
      `/matches?error=${encodeURIComponent("No embedding API key configured (VOYAGE_API_KEY).")}`,
      303,
    );
  }

  const embedReport = await embedPending({
    facets: services.facets,
    chunks: services.chunks,
    embedder: services.embedder,
    clock: services.clock,
    logger,
  });
  const matchReport = await scorePending({
    matches: services.matches,
    model: services.embedder.model,
    clock: services.clock,
    logger,
  });

  const message = `Embedded ${embedReport.postingsEmbedded} posting` +
    `${embedReport.postingsEmbedded === 1 ? "" : "s"} and ` +
    `${embedReport.facetsEmbedded} facet${embedReport.facetsEmbedded === 1 ? "" : "s"} · ` +
    `scored ${matchReport.pairsScored} pair${matchReport.pairsScored === 1 ? "" : "s"}` +
    (embedReport.postingsRemaining > 0
      ? ` · ${embedReport.postingsRemaining} postings still queued — refresh again to continue`
      : "");
  return c.redirect(`/matches?notice=${encodeURIComponent(message)}`, 303);
});

matchRoutes.get("/matches/:postingId", async (c) => {
  const services = c.get("services");
  let postingId: PostingId;
  try {
    postingId = asPostingId(c.req.param("postingId"));
  } catch {
    return c.notFound();
  }

  const posting = await services.postings.get(postingId);
  if (posting === null) return c.notFound();

  const model = services.embedder?.model;
  const [matches, thresholds, chunkScores, board] = await Promise.all([
    services.matches.forPosting(postingId),
    loadBucketThresholds(services.settings),
    model !== undefined
      ? services.chunks.postingChunkScores(postingId, model)
      : Promise.resolve([]),
    services.boards.get(posting.boardId),
  ]);

  return c.html(
    <MatchDetailPage
      posting={posting}
      companyName={board?.companyName ?? posting.boardId}
      matches={matches}
      chunkScores={chunkScores}
      thresholds={thresholds}
      csrfToken={c.get("csrfToken")}
    />,
  );
});
