/**
 * Photographic protocol and mobile capture session.
 *
 * Closes the gap section 9.3 of the specification left open: it asks the patient PWA for "captura de
 * imagen con guía de encuadre" and "envío al centro", but never says how a phone gets bound to a
 * case. A short-lived signed session, handed over as a QR code at intake, is that binding.
 */

/**
 * The shots the clinic asks for. The frontal view and both profiles are the minimum for a facial
 * acne case — the IGA grade is judged on the whole face, and one cheek can carry the lesions the
 * other one lacks; the rest are the additions of Módulo A/B (acercamiento, borde, tronco).
 */
export const SHOT_KEYS = [
  'general',
  'acercamiento',
  'borde',
  'perfil_derecho',
  'perfil_izquierdo',
  'pecho',
  'espalda',
  'otra',
] as const;
export type ShotKey = (typeof SHOT_KEYS)[number];

export interface ShotDefinition {
  key: ShotKey;
  label: string;
  /** Shown on the phone, above the camera button. */
  instruction: string;
  required: boolean;
}

export const SHOT_DEFINITIONS: readonly ShotDefinition[] = [
  {
    key: 'general',
    label: 'Vista general',
    instruction:
      'Rostro completo de frente, con los ojos abiertos y dentro de la foto, con luz natural y sin maquillaje.',
    required: true,
  },
  {
    key: 'acercamiento',
    label: 'Acercamiento',
    instruction: 'Acérquese a unos 20 cm de las lesiones, sin que salga borrosa.',
    required: false,
  },
  {
    key: 'borde',
    label: 'Borde con piel sana',
    instruction: 'Encuadre el límite entre la zona con lesiones y la piel sana.',
    required: false,
  },
  {
    key: 'perfil_derecho',
    label: 'Perfil derecho',
    instruction: 'Gire el rostro hacia la izquierda para fotografiar la mejilla derecha.',
    required: true,
  },
  {
    key: 'perfil_izquierdo',
    label: 'Perfil izquierdo',
    instruction: 'Gire el rostro hacia la derecha para fotografiar la mejilla izquierda.',
    required: true,
  },
  {
    key: 'pecho',
    label: 'Pecho',
    instruction: 'Solo si hay lesiones en el pecho.',
    required: false,
  },
  {
    key: 'espalda',
    label: 'Espalda',
    instruction: 'Solo si hay lesiones en la espalda. Pida ayuda para tomarla.',
    required: false,
  },
  {
    key: 'otra',
    label: 'Otra toma',
    instruction: 'Cualquier otra zona que el profesional le haya indicado.',
    required: false,
  },
] as const;

export const REQUIRED_SHOT_KEYS: readonly ShotKey[] = SHOT_DEFINITIONS.filter(
  (shot) => shot.required,
).map((shot) => shot.key);

export function isShotKey(value: unknown): value is ShotKey {
  return typeof value === 'string' && (SHOT_KEYS as readonly string[]).includes(value);
}

export function shotLabel(key: ShotKey): string {
  return SHOT_DEFINITIONS.find((shot) => shot.key === key)?.label ?? key;
}

/**
 * Required shots with no photograph yet, in protocol order.
 *
 * A `null` key is a photograph that followed no protocol (seeder images, uploads before the desktop
 * route recorded the shot): it counts for nothing here, because nobody can tell which view it is.
 */
export function missingRequiredShots(shotKeys: ReadonlyArray<ShotKey | null>): ShotKey[] {
  const present = new Set(shotKeys.filter((key): key is ShotKey => key !== null));
  return REQUIRED_SHOT_KEYS.filter((key) => !present.has(key));
}

/** The 400 text: which shots are missing, by their human label, so the desk knows what to retake. */
export function describeMissingShots(missing: ReadonlyArray<ShotKey>): string {
  const labels = missing.map(shotLabel).join(', ');
  return (
    `El caso no tiene las tomas obligatorias del protocolo fotográfico (${labels}). ` +
    'Complete las fotografías antes de analizar o diagnosticar.'
  );
}

/**
 * What the engine's second opinion saw in an admitted photograph (`acne_check` of `/image/screen`).
 * `otra_condicion` never reaches the record: such an upload is refused.
 */
export const ACNE_CHECKS = ['acne', 'piel_sana', 'indeterminado'] as const;
export type AcneCheck = (typeof ACNE_CHECKS)[number];

export function isAcneCheck(value: unknown): value is AcneCheck {
  return typeof value === 'string' && (ACNE_CHECKS as readonly string[]).includes(value);
}

/**
 * Whether the case must not be analysed because none of its required shots shows acne.
 *
 * Reads the latest photograph of each required shot, the ones `requestForCase` sends. Only blocks
 * when EVERY one of them was checked and none says `acne`: a shot without a reading (older upload,
 * rule switched off in the engine) means nothing was claimed, and the case stays analysable.
 *
 * @param images in chronological order, as `findByCase` returns them.
 */
export function lacksAcneEvidence(
  images: ReadonlyArray<{ shotKey: ShotKey | null; acneCheck: AcneCheck | null }>,
): boolean {
  const latest = new Map<ShotKey, AcneCheck | null>();
  for (const image of images) {
    if (image.shotKey !== null && REQUIRED_SHOT_KEYS.includes(image.shotKey)) {
      latest.set(image.shotKey, image.acneCheck);
    }
  }
  const readings = [...latest.values()];
  if (readings.length === 0 || readings.some((reading) => reading === null)) return false;
  return !readings.includes('acne');
}

/** The 400 text when no required shot shows acne. */
export const NO_ACNE_EVIDENCE_MESSAGE =
  'Ninguna de las fotografías del caso muestra acné. Al menos una toma debe mostrar las lesiones ' +
  'para poder analizar el caso: repita la que corresponda a la zona afectada.';

/**
 * Upload cap per capture session.
 *
 * The mobile upload endpoint is public — it is authorised by the QR token alone — so the blast
 * radius of a leaked link has to be bounded by something other than authentication. Eight covers the
 * three required shots plus every optional one with room to retake, and nothing more.
 */
export const CAPTURE_DEFAULT_MAX_UPLOADS = 8;
export const CAPTURE_MAX_UPLOADS_LIMIT = 20;

/** Same 15-minute window as the signed image URLs of RNF-02. */
export const CAPTURE_DEFAULT_TTL_SECONDS = 900;
