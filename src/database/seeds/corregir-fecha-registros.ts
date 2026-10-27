import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import dataSource from '../data-source';

/**
 * Segunda parte de `corregir-fecha-carga.ts`: lleva al día real de trabajo (lunes 19/10/2026) los
 * registros que cuelgan de cada caso y que seguían con la fecha de la carga.
 *
 *  - Previos a la revisión (consentimiento, anamnesis, imágenes, inferencias de la IA): se mueven con
 *    el MISMO desplazamiento que sufrió su caso, de modo que conservan su distancia entre sí.
 *  - Posteriores (diagnóstico, receta, cierre): se anclan al fin real del cronómetro (t₁).
 *  - Elecciones de lectura (durante la revisión): se anclan a t₀ con su distancia original.
 *
 * NO toca `registros_auditoria`: es la bitácora de lo que realmente ocurrió y modificarla borraría el
 * rastro de esta propia corrección. El respaldo `previo-correccion-fechas-*.json` guarda las fechas
 * originales de los casos y los cronómetros.
 *
 *   ts-node -r tsconfig-paths/register src/database/seeds/corregir-fecha-registros.ts <respaldo.json>          (simula)
 *   ts-node -r tsconfig-paths/register src/database/seeds/corregir-fecha-registros.ts <respaldo.json> --apply  (ejecuta)
 */

type Row = Record<string, unknown>;
const ms = (d: unknown): number => new Date(d as string).getTime();

async function main(): Promise<void> {
  const file = process.argv[2];
  const apply = process.argv.includes('--apply');
  if (file === undefined || file.startsWith('--')) {
    throw new Error('Indique el respaldo previo-correccion-fechas-*.json.');
  }
  const original = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Row[]>;
  const origCase = new Map((original['casos'] ?? []).map((c) => [c['id'] as string, c]));
  const origTiming = new Map(
    (original['cronometrajes_revision'] ?? []).map((t) => [t['caso_id'] as string, t]),
  );

  await dataSource.initialize();
  const cases = (await dataSource.query<Row[]>(
    `SELECT id, paciente_id, creado_en FROM casos WHERE es_sintetico = false`,
  ));
  const timings = new Map(
    (
      (await dataSource.query<Row[]>(
        `SELECT caso_id, t0, t1 FROM cronometrajes_revision WHERE modo_estudio_codigo = 'postest'`,
      ))
    ).map((t) => [t['caso_id'] as string, t]),
  );

  const maxImg = ((await dataSource.query<Row[]>(`SELECT max(creado_en) m FROM imagenes_caso`)))[0]?.['m'];
  if (ms(maxImg) < ms('2026-10-21T00:00:00Z')) {
    throw new Error('Los registros ya parecen estar en el 19/10: no se repite.');
  }

  const plan = cases.map((c) => {
    const id = c['id'] as string;
    const o = origCase.get(id);
    const ot = origTiming.get(id);
    const nt = timings.get(id);
    if (o === undefined || ot === undefined || nt === undefined) {
      throw new Error(`Falta información original del caso ${id}.`);
    }
    return {
      caseId: id,
      patientId: c['paciente_id'] as string,
      deltaMs: ms(c['creado_en']) - ms(o['creado_en']),
      t0: new Date(nt['t0'] as string),
      t1: new Date(nt['t1'] as string),
      origT0: new Date(ot['t0'] as string),
      origT1: new Date(ot['t1'] as string),
    };
  });

  console.log(apply ? '== MODO APLICAR ==' : '== SIMULACIÓN (agregue --apply) ==', `${plan.length} casos`);
  const sample = plan[0];
  if (sample !== undefined) {
    console.log(` ej. desplazamiento del caso ${sample.caseId.slice(0, 8)}: ${(sample.deltaMs / 3_600_000).toFixed(2)} h`);
  }
  if (!apply) {
    await dataSource.destroy();
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dir = join(__dirname, '..', '..', '..', '..', 'acne-infra', 'backups');
  mkdirSync(dir, { recursive: true });
  const dump: Record<string, unknown> = {};
  for (const t of [
    'consentimientos', 'anamnesis_caso', 'respuestas_anamnesis', 'imagenes_caso', 'inferencias_ia',
    'trabajos_inferencia', 'lecturas_elegidas', 'recetas', 'diagnosticos', 'cronometrajes_revision',
    'pacientes', 'casos', 'jornadas_trabajo',
  ]) {
    dump[t] = await dataSource.query(`SELECT * FROM "${t}"`);
  }
  const backup = join(dir, `previo-correccion-registros-${stamp}.json`);
  writeFileSync(backup, JSON.stringify(dump, null, 1));
  console.log(`Respaldo: ${backup}`);

  await dataSource.transaction(async (m) => {
    await m.query(
      `CREATE TEMP TABLE _d (caso_id uuid, paciente_id uuid, delta_ms bigint, t0 timestamptz, t1 timestamptz, o_t0 timestamptz, o_t1 timestamptz) ON COMMIT DROP`,
    );
    await m.query(
      `INSERT INTO _d SELECT * FROM unnest($1::uuid[],$2::uuid[],$3::bigint[],$4::timestamptz[],$5::timestamptz[],$6::timestamptz[],$7::timestamptz[])`,
      [
        plan.map((p) => p.caseId), plan.map((p) => p.patientId), plan.map((p) => p.deltaMs),
        plan.map((p) => p.t0), plan.map((p) => p.t1), plan.map((p) => p.origT0), plan.map((p) => p.origT1),
      ],
    );
    const D = `(d.delta_ms * interval '1 millisecond')`;

    // Previos a la revisión: mismo desplazamiento que el caso.
    await m.query(`UPDATE imagenes_caso t SET creado_en = t.creado_en + ${D} FROM _d d WHERE t.caso_id = d.caso_id`);
    await m.query(`UPDATE inferencias_ia t SET creado_en = t.creado_en + ${D} FROM _d d WHERE t.caso_id = d.caso_id`);
    await m.query(
      `UPDATE trabajos_inferencia t SET creado_en = t.creado_en + ${D}, actualizado_en = t.actualizado_en + ${D},
              bloqueado_en = t.bloqueado_en + ${D} FROM _d d WHERE t.caso_id = d.caso_id`,
    );
    await m.query(
      `UPDATE anamnesis_caso t SET creado_en = t.creado_en + ${D}, actualizado_en = t.actualizado_en + ${D}
         FROM _d d WHERE t.caso_id = d.caso_id`,
    );
    await m.query(
      `UPDATE respuestas_anamnesis r SET respondida_en = r.respondida_en + ${D}
         FROM anamnesis_caso a JOIN _d d ON d.caso_id = a.caso_id WHERE r.anamnesis_id = a.id`,
    );
    await m.query(
      `UPDATE consentimientos t SET aceptado_en = t.aceptado_en + ${D}, creado_en = t.creado_en + ${D}
         FROM _d d WHERE t.paciente_id = d.paciente_id`,
    );
    await m.query(
      `UPDATE pacientes t SET consentimiento_en = t.consentimiento_en + ${D}, actualizado_en = t.actualizado_en + ${D}
         FROM _d d WHERE t.id = d.paciente_id`,
    );

    // Durante la revisión: anclado a t0, con la distancia original acotada a la duración de la revisión.
    await m.query(
      `UPDATE lecturas_elegidas t SET
          elegida_en = d.t0 + LEAST(GREATEST(t.elegida_en - d.o_t0, interval '0'), d.t1 - d.t0),
          retirada_en = CASE WHEN t.retirada_en IS NULL THEN NULL
                        ELSE d.t0 + LEAST(GREATEST(t.retirada_en - d.o_t0, interval '0'), d.t1 - d.t0) END
         FROM _d d WHERE t.caso_id = d.caso_id`,
    );

    // Posteriores: ancladas al fin real del cronómetro (t1), conservando la distancia al diagnóstico.
    await m.query(
      `UPDATE recetas r SET creado_en = d.t1 + (r.creado_en - dg.creado_en),
              firmado_en = CASE WHEN r.firmado_en IS NULL THEN NULL ELSE d.t1 + (r.firmado_en - dg.creado_en) END
         FROM _d d JOIN diagnosticos dg ON dg.caso_id = d.caso_id WHERE r.caso_id = d.caso_id`,
    );
    await m.query(
      `UPDATE casos c SET cerrado_en = CASE WHEN c.cerrado_en IS NULL THEN NULL ELSE d.t1 + (c.cerrado_en - dg.creado_en) END
         FROM _d d JOIN diagnosticos dg ON dg.caso_id = d.caso_id WHERE c.id = d.caso_id`,
    );
    await m.query(`UPDATE diagnosticos dg SET creado_en = d.t1 FROM _d d WHERE dg.caso_id = d.caso_id`);
    await m.query(`UPDATE casos c SET actualizado_en = COALESCE(c.cerrado_en, d.t1) FROM _d d WHERE c.id = d.caso_id`);
    await m.query(`UPDATE cronometrajes_revision SET creado_en = t0 WHERE modo_estudio_codigo = 'postest'`);
    await m.query(`UPDATE jornadas_trabajo SET creado_en = iniciada_en`);
  });
  console.log('Listo.');
  await dataSource.destroy();
}

main().catch((e: unknown) => {
  console.error('Fallo:', e);
  process.exit(1);
});
