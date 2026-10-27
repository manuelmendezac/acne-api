import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import dataSource from '../data-source';

/**
 * Corrige la fecha de trabajo de una carga hecha después de los hechos.
 *
 * El trabajo se hizo el lunes 19/10/2026 y se cargó al sistema después. Este script:
 *   1. respalda en JSON las filas que toca,
 *   2. une las dos jornadas de mañana (error de captura) en una sola,
 *   3. pasa jornadas, casos y pacientes al lunes 19, dentro de 08:00-13:00 (mañana) y
 *      14:00-20:00 (tarde), hora de Perú (UTC-5),
 *   4. deja en `notas` la fecha original de carga y el motivo.
 *
 * NO toca `cronometrajes_revision`: los tiempos de revisión medidos durante la carga no son los de la
 * revisión real y no se inventan duraciones. Ver el aviso al final de la ejecución.
 *
 * La hora de cada caso es la `hora_inicio` del Anexo 4: la creación del caso se fija en ese instante
 * (aproximación: el registro del paciente pudo ser minutos antes).
 *
 *   ts-node -r tsconfig-paths/register src/database/seeds/corregir-fecha-carga.ts <tiempos.csv>           (simula)
 *   ts-node -r tsconfig-paths/register src/database/seeds/corregir-fecha-carga.ts <tiempos.csv> --apply   (ejecuta)
 *
 * El CSV es el mismo de `importar-tiempos.ts` (codigo_caso,hora_inicio,minutos): de ahí salen la hora
 * de cada caso y su turno (antes de las 14:00 = mañana).
 */

const DIA = '2026-10-19'; // lunes
const UTC_OFFSET_H = 5; // Perú: UTC-5, sin horario de verano

/** Hora local de Perú del día `DIA` -> instante UTC. */
function peruAt(hour: number): Date {
  const base = new Date(`${DIA}T00:00:00.000Z`);
  return new Date(base.getTime() + (hour + UTC_OFFSET_H) * 3_600_000);
}

interface Window {
  start: Date;
  end: Date;
  hours: number;
}
const MANANA: Window = { start: peruAt(8), end: peruAt(13), hours: 5 };
const TARDE: Window = { start: peruAt(14), end: peruAt(20), hours: 6 };

interface CaseRow {
  id: string;
  paciente_id: string;
  creado_en: Date;
  notas: string | null;
}
interface JornadaRow {
  id: string;
  turno_codigo: string;
  iniciada_en: Date;
  finalizada_en: Date | null;
  casos_revisados: number;
  notas: string | null;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  await dataSource.initialize();

  const jornadas = (await dataSource.query<JornadaRow[]>(
    `SELECT id, turno_codigo, iniciada_en, finalizada_en, casos_revisados, notas
       FROM jornadas_trabajo WHERE es_sintetico = false ORDER BY iniciada_en`,
  ));
  const casos = (await dataSource.query<CaseRow[]>(
    `SELECT id, paciente_id, creado_en, notas FROM casos WHERE es_sintetico = false ORDER BY creado_en`,
  ));

  const mananas = jornadas.filter((j) => j.turno_codigo === 'manana');
  const tardes = jornadas.filter((j) => j.turno_codigo === 'tarde');
  if (mananas.length !== 2 || tardes.length !== 1) {
    throw new Error(
      `Se esperaban 2 jornadas de mañana y 1 de tarde y hay ${mananas.length}/${tardes.length}. No se toca nada.`,
    );
  }
  const [keepM, dropM] = mananas as [JornadaRow, JornadaRow];
  const tarde = tardes[0] as JornadaRow;

  const csvPath = process.argv[2];
  if (csvPath === undefined || csvPath.startsWith('--')) throw new Error('Indique el CSV de tiempos.');
  const starts = new Map<string, number>();
  for (const line of readFileSync(csvPath, 'utf8').replace(/^﻿/, '').split(/\r?\n/).slice(1)) {
    if (line.trim() === '') continue;
    const [code, hhmm] = line.split(',').map((c) => c.trim());
    const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm ?? '');
    if (code === undefined || m === null) throw new Error(`Línea inválida en el CSV: «${line}»`);
    starts.set(code, Number(m[1]) * 60 + Number(m[2]));
  }

  const codes = (await dataSource.query<Array<{ id: string; codigo_caso: string }>>(`SELECT id, codigo_caso FROM casos WHERE es_sintetico = false`));
  const codeOf = new Map(codes.map((c) => [c.id, c.codigo_caso]));
  const plan = casos.map((c) => {
    const code = codeOf.get(c.id) as string;
    const minutes = starts.get(code);
    if (minutes === undefined) throw new Error(`El caso ${code} no está en el CSV.`);
    const inManana = minutes >= 8 * 60 && minutes <= 13 * 60;
    const inTarde = minutes >= 14 * 60 && minutes <= 20 * 60;
    if (!inManana && !inTarde) throw new Error(`El caso ${code} empieza a las ${minutes / 60}h, fuera de 8-13 y 14-20.`);
    return {
      c,
      nuevo: new Date(peruAt(0).getTime() + minutes * 60_000),
      turno: inManana ? 'manana' : 'tarde',
    };
  });
  if (plan.length !== starts.size) throw new Error(`Hay ${plan.length} casos en la base y ${starts.size} en el CSV.`);
  const nManana = plan.filter((p) => p.turno === 'manana').length;
  const nTarde = plan.length - nManana;

  console.log(apply ? '== MODO APLICAR ==' : '== SIMULACIÓN (agregue --apply para ejecutar) ==');
  console.log(`Mañana: ${nManana} casos, ${MANANA.start.toISOString()} → ${MANANA.end.toISOString()} (UTC)`);
  console.log(`Tarde:  ${nTarde} casos, ${TARDE.start.toISOString()} → ${TARDE.end.toISOString()} (UTC)`);
  console.log(`Se une la jornada ${dropM.id} con ${keepM.id} y se elimina la primera.`);
  for (const p of plan.slice(0, 3).concat(plan.slice(-2)))
    console.log(` caso ${p.c.id.slice(0, 8)}  ${p.c.creado_en.toISOString()} → ${p.nuevo.toISOString()} (${p.turno})`);

  if (!apply) {
    await dataSource.destroy();
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dir = join(__dirname, '..', '..', '..', '..', 'acne-infra', 'backups');
  mkdirSync(dir, { recursive: true });
  const dump: Record<string, unknown> = {};
  for (const t of ['jornadas_trabajo', 'casos', 'pacientes', 'cronometrajes_revision'])
    dump[t] = await dataSource.query(`SELECT * FROM "${t}"`);
  const backup = join(dir, `previo-correccion-fechas-${stamp}.json`);
  writeFileSync(backup, JSON.stringify(dump, null, 1));
  console.log(`Respaldo: ${backup}`);

  const nota = (orig: Date): string =>
    `[Corrección de fecha ${stamp.slice(0, 10)}] Trabajo realizado el ${DIA}; cargado al sistema el ${orig.toISOString()}. ` +
    `La hora de creación del caso se fijó en la hora de inicio de revisión del Anexo 4.`;
  const concat = (prev: string | null, extra: string): string => (prev === null || prev === '' ? extra : `${prev}\n${extra}`);

  await dataSource.transaction(async (m) => {
    for (const p of plan) {
      // El paciente se creó segundos antes que el caso: se conserva esa distancia.
      const pac = (await m.query<Array<{ creado_en: Date }>>(`SELECT creado_en FROM pacientes WHERE id = $1`, [p.c.paciente_id]));
      const delta = p.c.creado_en.getTime() - (pac[0]?.creado_en ?? p.c.creado_en).getTime();
      await m.query(`UPDATE pacientes SET creado_en = $2 WHERE id = $1`, [
        p.c.paciente_id,
        new Date(p.nuevo.getTime() - Math.max(0, delta)),
      ]);
      await m.query(`UPDATE casos SET creado_en = $2, actualizado_en = $2, notas = $3 WHERE id = $1`, [
        p.c.id,
        p.nuevo,
        concat(p.c.notas, nota(p.c.creado_en)),
      ]);
    }

    const merged = `Se unió con la jornada de mañana ${dropM.id} (${dropM.iniciada_en.toISOString()} → ${dropM.finalizada_en?.toISOString() ?? 'abierta'}, ${dropM.casos_revisados} casos): error de captura.`;
    await m.query(
      `UPDATE jornadas_trabajo SET iniciada_en=$2, finalizada_en=$3, casos_revisados=$4, horas_declaradas=$5, tcad=$6, notas=$7 WHERE id=$1`,
      [keepM.id, MANANA.start, MANANA.end, nManana, MANANA.hours, nManana / MANANA.hours,
        concat(concat(keepM.notas, nota(keepM.iniciada_en)), merged)],
    );
    await m.query(`DELETE FROM jornadas_trabajo WHERE id = $1`, [dropM.id]);
    await m.query(
      `UPDATE jornadas_trabajo SET iniciada_en=$2, finalizada_en=$3, casos_revisados=$4, horas_declaradas=$5, tcad=$6, notas=$7 WHERE id=$1`,
      [tarde.id, TARDE.start, TARDE.end, nTarde, TARDE.hours, nTarde / TARDE.hours, concat(tarde.notas, nota(tarde.iniciada_en))],
    );
  });

  console.log(`Listo: ${plan.length} casos y pacientes, 2 jornadas.`);
  console.log('AVISO: cronometrajes_revision NO se modificó; sus tiempos son los de la carga, no los de la revisión.');
  await dataSource.destroy();
}

main().catch((error: unknown) => {
  console.error('Fallo:', error);
  process.exit(1);
});
