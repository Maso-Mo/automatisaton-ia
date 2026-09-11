import { describe, expect, it } from 'vitest';
import type { EditPlanView, MessageView } from '../../api/client';
import {
  briefMissingLabels,
  defaultSelection,
  formatTurnCost,
  mergeMessages,
  pendingProposals,
  planProposals,
  stageSummary,
} from './state';

/**
 * L'écran de conversation ne doit jamais laisser écrire en mémoire une
 * proposition sans citation, ni dupliquer un message après une reconnexion SSE.
 * Ces règles sont vérifiées ici, sans navigateur ni base.
 */

function plan(overrides: Partial<EditPlanView> = {}): EditPlanView {
  return {
    assistantMessageId: 'm-assistant',
    sourceMessageId: 'm-user',
    reply: 'Réponse',
    suggestedNext: 'continue',
    openQuestions: [],
    facts: [],
    skills: [],
    projectEdits: [],
    audiences: [],
    styles: [],
    ...overrides,
  };
}

describe('écran de conversation (docs/03 §7, docs/05 §3)', () => {
  it('affiche chaque proposition avec sa citation, y compris refusée', () => {
    const built = plan({
      facts: [
        {
          id: 'p1',
          status: 'pending',
          sourceQuote: 'j’ai automatisé 12 factures',
          rejectedReason: null,
          category: 'chiffre',
          statement: '12 factures automatisées',
        },
        {
          id: 'p2',
          status: 'rejected',
          sourceQuote: 'une citation inventée',
          rejectedReason: 'citation introuvable dans votre message',
          category: 'chiffre',
          statement: '500 clients',
        },
      ],
      skills: [
        {
          id: 's1',
          status: 'pending',
          sourceQuote: 'je code en TypeScript',
          rejectedReason: null,
          skill: 'TypeScript',
          level: 'avance',
        },
      ],
    });

    const proposals = planProposals(built);
    expect(proposals).toHaveLength(3);
    expect(proposals.find((item) => item.id === 'p2')?.rejectedReason).toContain('introuvable');
    expect(proposals.find((item) => item.id === 's1')?.label).toContain('TypeScript');
    expect(proposals.every((item) => item.sourceQuote.length > 0)).toBe(true);
  });

  it('ne présélectionne que les propositions en attente ET citées', () => {
    const built = plan({
      facts: [
        {
          id: 'ok',
          status: 'pending',
          sourceQuote: 'j’ai automatisé 12 factures',
          rejectedReason: null,
          statement: '12 factures',
        },
        {
          id: 'invente',
          status: 'rejected',
          sourceQuote: 'citation inventée',
          rejectedReason: 'citation introuvable dans votre message',
          statement: '500 clients',
        },
        {
          id: 'deja',
          status: 'accepted',
          sourceQuote: 'déjà acceptée',
          rejectedReason: null,
          statement: 'déjà en mémoire',
        },
      ],
    });

    expect(defaultSelection(built)).toEqual(['ok']);
    expect(pendingProposals(built).map((item) => item.id)).toEqual(['ok']);
  });

  it('fusionne les messages SSE sans doublon, dans l’ordre de création', () => {
    const first: MessageView = message('b', 2_000, 'assistant');
    const second: MessageView = message('a', 1_000, 'user');

    const merged = mergeMessages([first], [second, first]);
    expect(merged.map((item) => item.id)).toEqual(['a', 'b']);
  });

  it('rend un coût lisible et des libellés de champs, jamais des clés techniques', () => {
    expect(formatTurnCost(12_000, 900, 200)).toBe('0.0120 $ · 900 → 200 jetons');
    expect(briefMissingLabels(['formats', 'inconnu'])).toEqual([
      'Formats par plateforme',
      'inconnu',
    ]);
    expect(stageSummary('fact_extraction', 'facts', { facts: 'Faits confirmés' })).toBe(
      'À apprendre : Faits confirmés',
    );
    expect(stageSummary('brief_ready', null, {})).toBe('Fiche maître prête à être générée');
    expect(stageSummary('closed', 'facts', {})).toBe('Entretien terminé');
  });
});

function message(id: string, createdAt: number, role: string): MessageView {
  return {
    id,
    conversationId: 'c1',
    role,
    content: id,
    contentJson: null,
    messageType: 'text',
    agent: null,
    tokensIn: null,
    tokensOut: null,
    costMicroUsd: 0,
    createdAt,
  };
}
