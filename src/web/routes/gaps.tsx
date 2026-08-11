/** @jsxImportSource hono/jsx */

/**
 * Vocabulary gaps.
 *
 * The whole page is an observation with the conclusion deliberately withheld.
 * Every count is a count of postings, every term links to the postings it came
 * from, and the page says in as many words that it cannot tell a missing skill
 * from a missing word — because it cannot, and a page that implied otherwise
 * would be inviting the reader to pad a resume (§8).
 */

import { Hono } from "hono";
import type { FC } from "hono/jsx";
import { Layout } from "@web/layout.tsx";
import { Metric, Notice, Tabs } from "@web/components.tsx";
import type { AppEnv } from "@web/types.ts";
import {
  DEFAULT_VOCABULARY_OPTIONS,
  findVocabularyGaps,
  type GapKind,
  gapKind,
  type TermDocument,
  type VocabularyGap,
  type VocabularyReport,
} from "@domain/discovery/vocabulary.ts";
import type { PostingId } from "@platform/ids.ts";

/** What each kind of gap actually means, and what to do about it. */
const KINDS: Record<GapKind, { label: string; meaning: string }> = {
  "unknown-territory": {
    label: "Not written anywhere",
    meaning:
      "Absent from both the matching profile and the fact set. Either you have not done it, or " +
      "you have and have never used this word for it. Only you can say which.",
  },
  "not-on-the-resume": {
    label: "In your profile, not in your facts",
    meaning:
      "Your profile describes it, so matching can find these roles — but there is no fact to " +
      "cite, so no resume can mention it. If it is true, it belongs in the fact set.",
  },
  "not-in-the-profile": {
    label: "In your facts, not in your profile",
    meaning: "Your resume can claim it but the profile never says it, so matching cannot see it. " +
      "These roles are being scored without the evidence that would have matched them.",
  },
};

const ORDER: readonly GapKind[] = ["unknown-territory", "not-on-the-resume", "not-in-the-profile"];

const GapTable: FC<{ gaps: readonly VocabularyGap[] }> = ({ gaps }) => (
  <div class="table-scroll gap-above">
    <table>
      <thead>
        <tr>
          <th>Term</th>
          <th class="numeric">Postings</th>
          <th>For example</th>
        </tr>
      </thead>
      <tbody>
        {gaps.map((gap) => (
          <tr key={gap.term}>
            <td class="posting-title">{gap.term}</td>
            <td class="numeric">{gap.postingCount}</td>
            <td class="field-hint">
              {gap.examples.map((example, index) => (
                <span key={example.id}>
                  {index > 0 ? ", " : ""}
                  <a href={`/matches/${encodeURIComponent(example.id)}`}>{example.label}</a>
                </span>
              ))}
              {gap.postingCount > gap.examples.length &&
                ` and ${gap.postingCount - gap.examples.length} more`}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

const GapsPage: FC<{
  report: VocabularyReport;
  scope: "matched" | "listed";
  csrfToken: string;
  minPostings: number;
}> = (props) => {
  const byKind = new Map<GapKind, VocabularyGap[]>();
  for (const gap of props.report.gaps) {
    const kind = gapKind(gap);
    const existing = byKind.get(kind);
    if (existing === undefined) byKind.set(kind, [gap]);
    else existing.push(gap);
  }

  return (
    <Layout title="Gaps" current="profile" csrfToken={props.csrfToken}>
      <Tabs
        label="Profile sections"
        items={[
          { href: "/profile", label: "Profile" },
          { href: "/gaps", label: "Gaps", current: true },
        ]}
      />
      <div class="page-head">
        <div>
          <h1>Vocabulary gaps</h1>
          <p class="lede">
            Words that keep appearing in the roles you are matching, and appear nowhere in what you
            have written about yourself.
          </p>
        </div>
      </div>

      <Notice kind="warn">
        <strong>This cannot tell a missing skill from a missing word.</strong>{" "}
        A term here might be something you have never done, or something you have done for years and
        described differently. Those need opposite responses, and nothing on this page can
        distinguish them — so it counts, and leaves the conclusion to you.
      </Notice>

      <section class="panel">
        <header>
          <h2>What was examined</h2>
        </header>
        <div class="metrics">
          <Metric
            label="postings examined"
            value={props.report.postingsExamined}
            hint={props.scope === "matched"
              ? "Currently listed postings with at least a weak match against your profile"
              : "Every currently listed posting — nothing has been scored yet"}
          />
          <Metric
            label="recurring terms"
            value={props.report.termsConsidered}
            hint={`Distinct terms used by at least ${props.minPostings} of them`}
          />
          <Metric label="gaps found" value={props.report.gaps.length} />
          <Metric
            label="boilerplate segments excluded"
            value={props.report.boilerplateSegmentsRemoved}
            hint="Paragraphs and sentences a board pastes into most of its own postings verbatim — legal disclaimers, EEO statements, benefits blurbs"
          />
        </div>
        <p class="panel-note gap-above">
          A term in one posting is that posting's vocabulary, not the market's, so nothing below
          appears in fewer than {props.minPostings}{" "}
          of them. Terms already present in both your profile and your fact set are not shown at
          all. Ordinary English, job-posting boilerplate, and text repeated near-verbatim across
          most of a board's own postings are filtered out.
        </p>
      </section>

      {props.report.postingsExamined === 0 && (
        <section class="panel">
          <p class="empty">
            There is nothing to compare against yet. Add a board, collect some postings, and write
            at least one profile facet.
          </p>
        </section>
      )}

      {ORDER.map((kind) => {
        const gaps = byKind.get(kind);
        if (gaps === undefined || gaps.length === 0) return null;
        return (
          <section class="panel" key={kind}>
            <header>
              <h2>{KINDS[kind].label}</h2>
              <span class="chip">{gaps.length}</span>
            </header>
            <p class="panel-note">{KINDS[kind].meaning}</p>
            <GapTable gaps={gaps} />
          </section>
        );
      })}
    </Layout>
  );
};

export const gapRoutes = new Hono<AppEnv>();

gapRoutes.get("/gaps", async (c) => {
  const services = c.get("services");

  const minPostings = (() => {
    const raw = Number(c.req.query("min") ?? "");
    return Number.isInteger(raw) && raw >= 1 && raw <= 50
      ? raw
      : DEFAULT_VOCABULARY_OPTIONS.minPostings;
  })();

  const [facets, facts, candidates] = await Promise.all([
    services.facets.list(),
    services.facts.list(),
    services.matches.listCandidates({}),
  ]);

  // Scope: the roles you are actually matching, weak ones included — a role you
  // match weakly may be weak *because* of the vocabulary you never used, which
  // is exactly what this page is for. Gaps against jobs you would never apply
  // to are somebody else's market, not your blind spot. When nothing has been
  // scored — no embedding key, or nothing embedded yet — fall back to every
  // listed posting and say so rather than showing an empty page.
  const matched = new Set<PostingId>(candidates.map((candidate) => candidate.postingId));
  const scope = matched.size > 0 ? "matched" : "listed";

  // A single-user corpus: a few thousand postings at most, and this page is not
  // on any hot path.
  const { postings } = await services.postings.list({ limit: 5_000 });
  const documents: TermDocument[] = postings
    .filter((posting) => scope === "listed" || matched.has(posting.id))
    .map((posting) => ({
      id: posting.id,
      label: posting.title,
      text: posting.descriptionText,
      groupId: posting.boardId,
    }));

  // Only active facets: a retired one is not what the matcher sees.
  const profileText = facets
    .filter((facet) => facet.active)
    .map((facet) => `${facet.name}\n${facet.content}`)
    .join("\n");
  const dossierText = facts
    .filter((fact) => fact.active)
    .map((fact) => `${fact.text}\n${fact.organization ?? ""}\n${fact.tags.join("\n")}`)
    .join("\n");

  const report = findVocabularyGaps(documents, profileText, dossierText, { minPostings });

  return c.html(
    <GapsPage
      report={report}
      scope={scope}
      minPostings={minPostings}
      csrfToken={c.get("csrfToken")}
    />,
  );
});
