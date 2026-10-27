import dataSource from '../data-source';

/**
 * Fija como patrón de referencia de cada caso el diagnóstico IGA del especialista (postest).
 *
 * Con esa referencia, TPD mide la concordancia de la IA con el dermatólogo —lo que el Anexo 5 llama
 * "diagnóstico de referencia del especialista"— y no una verdad externa de consenso. Hay que
 * declararlo así en el informe: en postest el especialista vio la sugerencia de la IA, de modo que
 * el porcentaje es una concordancia, no una exactitud independiente.
 *
 * Marca cada caso con `[ref:especialista]` en `notas` para saber cuáles se fijaron aquí. Es
 * re-ejecutable: tras corregir un diagnóstico, volver a correrlo actualiza esos casos. Un caso con
 * un patrón de consenso real (sin la marca) no se toca.
 *
 *   ts-node -r tsconfig-paths/register src/database/seeds/fijar-referencia-especialista.ts           (simula)
 *   ts-node -r tsconfig-paths/register src/database/seeds/fijar-referencia-especialista.ts --apply   (ejecuta)
 */
const MARK = '[ref:especialista]';

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  await dataSource.initialize();

  const rows = (await dataSource.query<Array<{ id: string; codigo_caso: string; ref: string | null; notas: string | null; diag_id: string; cls: string }>>(
    `SELECT c.id, c.codigo_caso, c.clase_iga_referencia ref, c.notas, d.id diag_id, d.clase_iga_codigo cls
       FROM casos c JOIN diagnosticos d ON d.caso_id = c.id AND d.modo_estudio_codigo = 'postest'
      WHERE c.es_sintetico = false
        AND (c.clase_iga_referencia IS NULL OR COALESCE(c.notas,'') LIKE '%${MARK}%')`,
  ));

  const changes = rows.filter((r) => r.ref !== r.cls);
  console.log(`${apply ? '== APLICAR ==' : '== SIMULACIÓN =='} ${rows.length} casos elegibles, ${changes.length} cambian.`);
  if (!apply) {
    await dataSource.destroy();
    return;
  }

  await dataSource.transaction(async (m) => {
    for (const r of rows) {
      const notas =
        (r.notas ?? '').includes(MARK)
          ? r.notas
          : `${r.notas === null || r.notas === '' ? '' : `${r.notas}\n`}${MARK} Patrón de referencia = diagnóstico del especialista (concordancia IA vs dermatólogo).`;
      await m.query(`UPDATE casos SET clase_iga_referencia = $2, notas = $3 WHERE id = $1`, [r.id, r.cls, notas]);
      await m.query(`UPDATE diagnosticos SET acuerdo = 'correcto' WHERE id = $1`, [r.diag_id]);
    }
  });
  console.log('Listo.');
  await dataSource.destroy();
}

main().catch((e: unknown) => {
  console.error('Fallo:', e);
  process.exit(1);
});
