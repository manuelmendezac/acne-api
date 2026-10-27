import {
  REQUIRED_SHOT_KEYS,
  SHOT_DEFINITIONS,
  describeMissingShots,
  lacksAcneEvidence,
  missingRequiredShots,
  shotLabel,
  type AcneCheck,
  type ShotKey,
} from './capture';

/**
 * The required set is what `InferenceService.request`, `DiagnosesService.submit` and
 * `CasesService.resubmit` refuse a case without, so it is pinned here on purpose: changing it is a
 * clinical decision, not a refactor.
 */
describe('photographic protocol', () => {
  it('requires the frontal view and both profiles, and nothing else', () => {
    expect(REQUIRED_SHOT_KEYS).toEqual(['general', 'perfil_derecho', 'perfil_izquierdo']);
  });

  it('keeps every shot key unique', () => {
    expect(new Set(SHOT_DEFINITIONS.map((s) => s.key)).size).toBe(SHOT_DEFINITIONS.length);
  });
});

describe('missingRequiredShots', () => {
  it('reports every required shot when the case has no photographs', () => {
    expect(missingRequiredShots([])).toEqual(['general', 'perfil_derecho', 'perfil_izquierdo']);
  });

  it('reports only what is missing, in protocol order', () => {
    expect(missingRequiredShots(['perfil_izquierdo', 'general'])).toEqual(['perfil_derecho']);
  });

  it('is satisfied by one photograph per required shot, regardless of extras', () => {
    expect(
      missingRequiredShots(['general', 'general', 'perfil_derecho', 'perfil_izquierdo', 'pecho']),
    ).toEqual([]);
  });

  it('gives no credit to photographs that followed no protocol', () => {
    expect(missingRequiredShots([null, null, null])).toEqual([
      'general',
      'perfil_derecho',
      'perfil_izquierdo',
    ]);
  });
});

describe('describeMissingShots', () => {
  it('names the missing shots by their human label', () => {
    const text = describeMissingShots(['general', 'perfil_izquierdo']);
    expect(text).toContain('Vista general, Perfil izquierdo');
    expect(text).toMatch(/tomas obligatorias/);
  });

  it('falls back to the key when a label is unknown', () => {
    expect(shotLabel('general')).toBe('Vista general');
  });
});

describe('lacksAcneEvidence', () => {
  const shot = (
    shotKey: 'general' | 'perfil_derecho' | 'perfil_izquierdo',
    acneCheck: AcneCheck | null,
  ): { shotKey: ShotKey; acneCheck: AcneCheck | null } => ({
    shotKey,
    acneCheck,
  });

  it('blocks when every required shot was checked and none shows acne', () => {
    expect(
      lacksAcneEvidence([
        shot('general', 'piel_sana'),
        shot('perfil_derecho', 'piel_sana'),
        shot('perfil_izquierdo', 'indeterminado'),
      ]),
    ).toBe(true);
  });

  it('lets one photograph with acne be enough', () => {
    expect(
      lacksAcneEvidence([
        shot('general', 'piel_sana'),
        shot('perfil_derecho', 'acne'),
        shot('perfil_izquierdo', 'piel_sana'),
      ]),
    ).toBe(false);
  });

  it('does not block when a shot was never checked', () => {
    // Older photographs or the rule switched off: nothing was claimed about them.
    expect(lacksAcneEvidence([shot('general', 'piel_sana'), shot('perfil_derecho', null)])).toBe(
      false,
    );
    expect(lacksAcneEvidence([])).toBe(false);
  });

  it('reads the latest photograph of each shot, the one the analysis sends', () => {
    expect(lacksAcneEvidence([shot('general', 'acne'), shot('general', 'piel_sana')])).toBe(true);
    expect(lacksAcneEvidence([shot('general', 'piel_sana'), shot('general', 'acne')])).toBe(false);
  });
});
