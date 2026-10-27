/**
 * Turns the engine's screening codes into what the person holding the camera actually reads.
 *
 * The wording is written for the intake desk and for the patient's own phone, so it says what to do
 * next rather than what went wrong. The engine's own `reason` is appended when it has one: it is
 * specific to the image ("está de espaldas a la cámara") in a way a fixed catalogue cannot be.
 *
 * Nothing here mentions lesions or severity. The two codes about acne (`otra_condicion`,
 * `acne_sin_verificar`) only appear with `SECOND_OPINION_REQUIRE_ACNE` on in the engine, a rule the
 * research team asked for on 27/10/2026; the system is only used in the postest (the pretest is
 * transcribed from paper), so they cannot reach the pretest (RF-TR-01).
 */

const SUBJECT_MESSAGES: Readonly<Record<string, string>> = {
  persona_sin_rostro:
    'La fotografía no muestra el rostro. Se necesita la cara de frente para poder evaluarla.',
  piel_no_facial:
    'La fotografía muestra piel que no es del rostro. Este registro solo admite fotografías faciales.',
  otro: 'La imagen no es la fotografía de un rostro. Tome la foto directamente a la cara del paciente.',
  // A face IS there, but the photograph cannot be used: a second person, blur, darkness, too small.
  rostro_humano: 'La fotografía no sirve para evaluar el rostro.',
  // The second opinion saw another condition (vitiligo, melasma…): the reason carries its name.
  otra_condicion: 'La fotografía no corresponde a acné; parece otra condición de la piel.',
  acne_sin_verificar:
    'No se pudo comprobar si la fotografía muestra acné. Vuelva a subirla en unos segundos.',
};

const ISSUE_MESSAGES: Readonly<Record<string, string>> = {
  encuadre: 'Encuadre el rostro completo dentro de la fotografía.',
  enfoque: 'La fotografía está desenfocada; sujete el teléfono firme y vuelva a intentarlo.',
  iluminacion: 'La iluminación no es suficiente; busque luz natural o de frente.',
  oclusion: 'Algo cubre parte del rostro — cabello, mascarilla, mano o gafas.',
  resolucion: 'La resolución es baja; acérquese en lugar de ampliar con el zoom digital.',
  no_es_fotografia: 'La imagen no parece una fotografía tomada con cámara.',
};

/** Message for an image the record must not accept. */
export function describeRejection(subject: string, reason: string): string {
  const base = SUBJECT_MESSAGES[subject] ?? 'La imagen no sirve como fotografía clínica facial.';
  const detail = reason.trim();
  if (detail === '') return base;
  // For another condition the engine's reason is the condition's name, not a sentence.
  return subject === 'otra_condicion' ? `${base} Se observa: ${detail}.` : `${base} ${detail}`;
}

/** Warnings for an image that IS accepted but could have been taken better. */
export function describeIssues(issues: string[]): string[] {
  const seen = new Set<string>();
  const messages: string[] = [];
  for (const issue of issues) {
    const message = ISSUE_MESSAGES[issue];
    if (message === undefined || seen.has(message)) continue;
    seen.add(message);
    messages.push(message);
  }
  return messages;
}
