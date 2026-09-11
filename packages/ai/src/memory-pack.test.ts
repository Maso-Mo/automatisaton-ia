import { describe, expect, it } from 'vitest';
import { MEMORY_BUDGET, MIN_FACTS_IN_PACK, buildMemoryPack, renderMemoryPack } from './memory-pack';

/**
 * Le paquet de mémoire borne le coût d'un tour (docs/04 §5.1, §5.2). Trois
 * propriétés comptent, et ce fichier les fige :
 *
 * 1. les compétences survivent au budget (sans elles, le produit prête à
 *    l'utilisateur des compétences qu'il n'a pas) ;
 * 2. on ne descend **jamais** sous trois faits ;
 * 3. ce qui est écarté est **visible** (`droppedFactIds`), donc discutable.
 */

function fact(index: number, length = 60) {
  return {
    id: `fact-${index}`,
    category: 'chiffre',
    statement: `Fait ${index} ${'x'.repeat(length)}`,
    detail: null,
    importance: 4,
    verificationStatus: 'verified',
  };
}

const PROJECT = {
  id: 'p1',
  name: 'Projet',
  status: 'active',
  positioning: null,
  targetGoal: null,
  language: 'fr',
};

describe('paquet de mémoire (docs/04 §5)', () => {
  it('conserve les compétences et au moins trois faits, même sous pression', () => {
    const pack = buildMemoryPack({
      project: PROJECT,
      facts: Array.from({ length: 400 }, (_value, index) => fact(index, 200)),
      skillFacts: Array.from({ length: 40 }, (_value, index) => ({
        skill: `Compétence ${index}`,
        level: 'avance',
        evidence: null,
      })),
    });

    expect(pack.facts.length).toBeGreaterThanOrEqual(MIN_FACTS_IN_PACK);
    expect(pack.skillFacts.length).toBeGreaterThan(0);
    expect(pack.manifest.factIds.length).toBe(pack.facts.length);
    expect(pack.droppedFactIds.length).toBeGreaterThan(0);
    expect(pack.manifest.estimatedTokens).toBeLessThanOrEqual(
      MEMORY_BUDGET.facts + MEMORY_BUDGET.skills + MEMORY_BUDGET.styleAndAudience,
    );
    // Les apprentissages et l'anti-répétition sont vides en V1 : on ne prétend pas
    // les avoir sélectionnés (docs/04 §5.2, sacrifices dans l'ordre).
    expect(pack.learnings).toEqual([]);
    expect(pack.recentContent).toEqual([]);
  });

  it('rend un texte qui dit explicitement ce que la mémoire ne contient pas', () => {
    const pack = buildMemoryPack({
      project: PROJECT,
      facts: [fact(1, 20)],
      skillFacts: [{ skill: 'n8n', level: 'avance', evidence: null }],
      audience: {
        name: 'Indépendants',
        description: null,
        knowledgeLevel: 'debutant',
        painPoints: ['facturation'],
      },
    });

    const rendered = renderMemoryPack(pack, ['voice', 'strategy']);
    expect(rendered).toContain('n8n');
    expect(rendered).toContain('Indépendants');
    expect(rendered).toContain('voice, strategy');
    // Le modèle ne doit jamais recevoir un fait non confirmé présenté comme établi.
    expect(rendered).toContain('Faits confirmés');
  });
});
