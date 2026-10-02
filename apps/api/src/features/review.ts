import type { CriticOutput, FactCheckerOutput } from '@aia/shared';
import { ConflictError } from '@aia/shared';
import { contentBundle, markInReview, type ContentBundle, type EditorialPorts } from '@aia/core';
import type { EditorialAgents } from './agents';

export interface ReviewFeatureDeps {
  ports: EditorialPorts;
  agents: EditorialAgents;
}

function localCritic(): CriticOutput {
  return { verdict: 'pass', score: 80, notes: [], repetition_report: null };
}

/** Repli déterministe des tests : les chiffres sont critiques et ne sont étayés que par un fait vérifié. */
function localFactCheck(
  body: string,
  facts: Array<{ id: string; statement: string; verificationStatus: string }>,
): FactCheckerOutput {
  const claims: FactCheckerOutput['claims'] = [];
  for (const match of body.matchAll(/\b\d+(?:[.,]\d+)?\b/g)) {
    const number = match[0];
    if (!number || claims.some((claim) => claim.text.includes(number))) continue;
    const fact = facts.find(
      (candidate) =>
        candidate.verificationStatus === 'verified' && candidate.statement.includes(number),
    );
    claims.push({
      text: `Le contenu affirme une valeur de ${number}.`,
      claim_type: 'chiffre',
      verifiability: 'verifiable',
      risk: 'eleve',
      status: fact ? 'supported' : 'needs_user_confirmation',
      evidence: fact?.id ?? null,
      evidence_source: fact ? 'project_fact' : 'none',
    });
  }
  return { claims };
}

export async function reviewContent(
  deps: ReviewFeatureDeps,
  itemId: string,
): Promise<ContentBundle> {
  const opened = markInReview(deps.ports, itemId);
  const version = opened.version;
  if (!version) {
    throw new ConflictError('Aucune version à contrôler.', { code: 'CONTENT_NO_VERSION' });
  }
  const facts = deps.ports.memory.facts.list({ projectId: opened.item.projectId }).map((fact) => ({
    id: fact.id,
    statement: fact.statement,
    verificationStatus: fact.verificationStatus,
  }));

  const criticBundle = deps.agents.critic?.();
  const critic = criticBundle
    ? (
        await criticBundle.agent.run(
          {
            platform: opened.item.platform,
            title: version.title,
            hook: version.hook,
            body: version.body,
            recentPublishedBodies: [],
          },
          {
            callContext: {
              projectId: opened.item.projectId,
              contentId: opened.item.id,
              agent: 'critic',
              task: 'review',
              promptVersionId: criticBundle.prompt.promptVersionId,
            },
          },
        )
      ).output
    : localCritic();

  const factBundle = deps.agents.factChecker?.();
  const factCheck = factBundle
    ? (
        await factBundle.agent.run(
          { title: version.title, hook: version.hook, body: version.body, facts },
          {
            callContext: {
              projectId: opened.item.projectId,
              contentId: opened.item.id,
              agent: 'fact_checker',
              task: 'assess',
              promptVersionId: factBundle.prompt.promptVersionId,
            },
          },
        )
      ).output
    : localFactCheck(version.body, facts);

  deps.ports.store.updateVersionQuality(version.id, critic.score);
  deps.ports.store.replaceNotes(opened.item.id, version.id, 'critic', [
    ...critic.notes.map((note) => ({
      noteType: 'critique' as const,
      severity: note.severity,
      message: note.message,
      anchorText: note.anchor_text ?? null,
    })),
    {
      noteType: 'decision' as const,
      severity: critic.verdict === 'pass' ? ('info' as const) : ('haute' as const),
      message: `Critic : verdict ${critic.verdict}, score ${critic.score}/100.`,
      anchorText: null,
    },
  ]);

  const verifiedFacts = new Set(
    facts.filter((fact) => fact.verificationStatus === 'verified').map((fact) => fact.id),
  );
  const claims = factCheck.claims.map((claim) => {
    const validEvidence =
      claim.status === 'supported' &&
      claim.evidence_source === 'project_fact' &&
      claim.evidence !== null &&
      verifiedFacts.has(claim.evidence);
    return {
      claim: claim.text,
      claimType: claim.claim_type,
      verifiability: claim.verifiability,
      risk: claim.risk,
      status: validEvidence
        ? ('supported' as const)
        : claim.status === 'supported'
          ? ('needs_user_confirmation' as const)
          : claim.status,
      evidence: validEvidence ? claim.evidence : null,
      evidenceSource: validEvidence ? ('project_fact' as const) : ('none' as const),
    };
  });
  deps.ports.store.replaceClaims(version.id, claims);
  deps.ports.store.replaceNotes(opened.item.id, version.id, 'fact_checker', [
    {
      noteType: 'decision',
      severity: claims.some((claim) => claim.risk === 'eleve' && claim.status !== 'supported')
        ? 'haute'
        : 'info',
      message: `Fact checker : ${claims.length} affirmation(s), ${claims.filter((claim) => claim.status === 'supported').length} étayée(s).`,
      anchorText: null,
    },
  ]);
  return contentBundle(deps.ports, itemId);
}
