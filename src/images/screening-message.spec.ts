import { describeIssues, describeRejection } from './screening-message';

/**
 * These strings are read at the intake desk and on the patient's own phone, in the pretest
 * condition as well as the postest. Two properties are pinned here because breaking either would
 * be invisible in the UI and expensive in the study:
 *
 *  - the message never mentions the disease (RF-TR-01);
 *  - it says what to do next, not merely what went wrong.
 */
describe('describeRejection', () => {
  it('says what to do about each kind of wrong subject', () => {
    expect(describeRejection('persona_sin_rostro', '')).toMatch(/rostro/i);
    expect(describeRejection('piel_no_facial', '')).toMatch(/faciales/i);
    expect(describeRejection('otro', '')).toMatch(/cara del paciente/i);
  });

  it('appends the engine detail, which is specific in a way a catalogue cannot be', () => {
    const message = describeRejection('persona_sin_rostro', 'La persona está de espaldas.');

    expect(message).toContain('La persona está de espaldas.');
  });

  it('falls back to a usable message for a subject it does not know', () => {
    // A new subject code added on the engine side must not surface as "undefined" to a technician.
    expect(describeRejection('categoria_futura', '')).toMatch(/fotografía clínica facial/i);
  });

  it('never mentions the disease', () => {
    // The rejection is shown during intake, which happens in the pretest too. A message that
    // revealed anything clinical would put the intervention on the wrong side of the experiment.
    const messages = [
      describeRejection('persona_sin_rostro', ''),
      describeRejection('piel_no_facial', ''),
      describeRejection('otro', ''),
      describeRejection('desconocido', ''),
      ...describeIssues(['encuadre', 'enfoque', 'iluminacion', 'oclusion', 'resolucion']),
    ].join(' ');

    expect(messages).not.toMatch(/acn[eé]|lesi[oó]n|grave|severo|leve|moderado|IGA|GAGS/i);
  });

  it('names the other condition the second opinion saw, without grading anything', () => {
    // Only with SECOND_OPINION_REQUIRE_ACNE on; the system is used in the postest only.
    const message = describeRejection('otra_condicion', 'vitíligo');

    expect(message).toMatch(/no corresponde a acné/i);
    expect(message).toContain('Se observa: vitíligo.');
    expect(message).not.toMatch(/grave|severo|leve|moderado|IGA|GAGS/i);
    expect(describeRejection('acne_sin_verificar', '')).toMatch(/vuelva a subirla/i);
  });
});

describe('describeIssues', () => {
  it('turns each code into an instruction', () => {
    expect(describeIssues(['enfoque'])[0]).toMatch(/desenfocada/i);
    expect(describeIssues(['iluminacion'])[0]).toMatch(/luz/i);
  });

  it('ignores codes it does not know instead of showing them raw', () => {
    expect(describeIssues(['enfoque', 'codigo_inventado'])).toHaveLength(1);
  });

  it('does not repeat itself', () => {
    expect(describeIssues(['enfoque', 'enfoque'])).toHaveLength(1);
  });

  it('returns nothing for a clean photograph', () => {
    expect(describeIssues([])).toEqual([]);
  });
});
