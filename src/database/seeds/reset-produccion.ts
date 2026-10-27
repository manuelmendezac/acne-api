import { randomBytes, scryptSync } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import dataSource from '../data-source';

/**
 * Deja la base lista para producción: respaldo JSON completo, vacía todo lo que NO es catálogo y
 * crea las cuentas reales del personal.
 *
 *   pnpm ts-node -r tsconfig-paths/register src/database/seeds/reset-produccion.ts           (simula)
 *   pnpm ts-node -r tsconfig-paths/register src/database/seeds/reset-produccion.ts --apply   (ejecuta)
 *
 * Los catálogos (roles, permisos, estados, escalas, ítems de encuesta, medicamentos, anamnesis,
 * CIE-10...) se conservan: `catalog-consistency.service` hace fallar la API si derivan del código.
 * La contraseña de cada cuenta se genera al azar y se escribe en un archivo local; en la base solo
 * queda el hash scrypt.
 */

const KEEP = new Set<string>([
  'migrations_history',
  'roles', 'permisos', 'roles_permisos', 'modos_estudio', 'estados_caso', 'transiciones_estado_caso',
  'estados_proceso', 'turnos', 'clases_iga', 'grados_gags', 'sexos', 'fototipos_fitzpatrick',
  'tomas_fotograficas', 'indicadores', 'hipotesis', 'escala_likert', 'items_encuesta',
  'secciones_anamnesis', 'tipos_pregunta', 'ambitos_anamnesis', 'tipos_detalle_valoracion', 'cie10',
  'estados_receta', 'canales_envio', 'origenes_medicion',
  // Sembradas por migración pero editables desde la app:
  'medicamentos', 'indicaciones_medicamento', 'preguntas_anamnesis', 'opciones_pregunta',
]);

interface Account {
  email: string;
  fullName: string;
  role: 'admin' | 'dermatologo' | 'tecnico';
  specialty: string | null;
}

const CLINICA = 'Clínica Salud del Sur';
const DOMAIN = 'saluddelsur.pe';

const ACCOUNTS: Account[] = [
  { email: 'admin@unt.edu.pe', fullName: 'Administrador del estudio', role: 'admin', specialty: null },
  {
    email: `jorge.asto@${DOMAIN}`,
    fullName: 'Dr. Jorge Kevin Asto Altamirano',
    role: 'dermatologo',
    specialty: `Médico dermatólogo · ${CLINICA}`,
  },
  {
    email: 'eduardo.rojas@hospitalbelen.pe',
    fullName: 'Dr. Eduardo Rodolfo Rojas Meza',
    role: 'dermatologo',
    specialty: 'Médico dermatólogo · Hospital Belén',
  },
  {
    email: `joselyn.lopez@${DOMAIN}`,
    fullName: 'Téc. Joselyn López Risco',
    role: 'tecnico',
    specialty: `Técnica · ${CLINICA}`,
  },
  ...[
    'Rosa Elena Quispe Mamani',
    'Carmen Lucía Flores Huamán',
    'Milagros Yesenia Condori Ccama',
    'Diana Carolina Vásquez Rojas',
    'Luz Marina Salas Paredes',
    'Katherine Jhoselyn Mendoza Ticona',
    'Yessica Paola Gutiérrez Chávez',
    'Mariela Fernanda Cáceres Soto',
    'Roxana Beatriz Apaza Layme',
    'Lizbeth Araceli Ramos Valdivia',
  ].map((name): Account => {
    const parts = name.split(' ');
    const slug = (s: string | undefined): string =>
      (s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    // nombre + primer apellido (los dos últimos tokens son los apellidos)
    const email = `${slug(parts[0])}.${slug(parts[parts.length - 2])}@${DOMAIN}`;
    return { email, fullName: `Téc. ${name}`, role: 'tecnico', specialty: `Técnica · ${CLINICA}` };
  }),
];

function hashPassword(password: string): string {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${scryptSync(password, salt, 64).toString('hex')}`;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  await dataSource.initialize();

  const rows = (await dataSource.query<Array<{ table_name: string }>>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`,
  ));
  const wipe = rows.map((r) => r.table_name).filter((t) => !KEEP.has(t));

  console.log(apply ? '== MODO APLICAR ==' : '== SIMULACIÓN (agregue --apply para ejecutar) ==');
  const counts: Record<string, number> = {};
  for (const t of wipe) {
    const res = (await dataSource.query<Array<{ n: number }>>(`SELECT COUNT(*)::int AS n FROM "${t}"`));
    const n = res[0]?.n ?? 0;
    counts[t] = n;
    console.log(` vaciar ${t.padEnd(36)} ${n} filas`);
  }

  // Un TRUNCATE ... CASCADE arrastra cualquier tabla que apunte a las vaciadas: si una de catálogo
  // apuntara a usuarios la perderíamos. Se comprueba antes de tocar nada.
  const fks = (await dataSource.query<Array<{ child: string; parent: string }>>(
    `SELECT conrelid::regclass::text AS child, confrelid::regclass::text AS parent
       FROM pg_constraint WHERE contype = 'f'`,
  ));
  const clean = (s: string): string => s.replace(/"/g, '').replace(/^public\./, '');
  const wiped = new Set(wipe);
  // `preguntas_anamnesis.actualizada_por` es ON DELETE SET NULL: se anula a mano y se trunca SIN
  // CASCADE, de modo que cualquier otra dependencia no prevista haga fallar el TRUNCATE en vez de
  // borrar en silencio una tabla conservada.
  const trouble = fks.filter(
    (f) => wiped.has(clean(f.parent)) && KEEP.has(clean(f.child)) && clean(f.child) !== 'preguntas_anamnesis',
  );
  if (trouble.length > 0) {
    console.error('Tablas conservadas que dependen de tablas a vaciar:', trouble);
    process.exit(1);
  }

  if (!apply) {
    console.log(`\nSe crearían ${ACCOUNTS.length} cuentas:`);
    for (const a of ACCOUNTS) console.log(` ${a.role.padEnd(12)} ${a.email.padEnd(40)} ${a.fullName}`);
    await dataSource.destroy();
    return;
  }

  // 1) Respaldo completo (incluye hashes: se necesita `hash_contrasena`, que es select:false en el ORM).
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dir = join(__dirname, '..', '..', '..', '..', 'acne-infra', 'backups');
  mkdirSync(dir, { recursive: true });
  const dump: Record<string, unknown[]> = {};
  for (const t of wipe) dump[t] = (await dataSource.query<unknown[]>(`SELECT * FROM "${t}"`));
  const backupFile = join(dir, `previo-limpieza-${stamp}.json`);
  writeFileSync(backupFile, JSON.stringify({ generadoEn: stamp, conteos: counts, tablas: dump }, null, 1));
  console.log(`\nRespaldo: ${backupFile}`);

  // 2) Limpieza y alta de cuentas en una sola transacción.
  const credentials: Array<Account & { password: string }> = [];
  await dataSource.transaction(async (m) => {
    // TRUNCATE no admite una tabla padre referenciada desde una tabla que no va en la lista, aunque la
    // columna esté en NULL. `usuarios` se borra con DELETE (SET NULL en preguntas_anamnesis); el
    // resto, que solo la referencia como hija, se trunca.
    await m.query(`TRUNCATE ${wipe.filter((t) => t !== 'usuarios').map((t) => `"${t}"`).join(', ')} RESTART IDENTITY`);
    await m.query(`DELETE FROM "usuarios"`);
    for (const a of ACCOUNTS) {
      const password = randomBytes(9).toString('base64url');
      await m.query(
        `INSERT INTO "usuarios" ("correo","hash_contrasena","nombre_completo","rol_codigo","especialidad","activo","es_sintetico")
         VALUES ($1,$2,$3,$4,$5,true,false)`,
        [a.email, hashPassword(password), a.fullName, a.role, a.specialty],
      );
      credentials.push({ ...a, password });
    }
  });

  const credFile = join(dir, `credenciales-produccion-${stamp}.txt`);
  writeFileSync(
    credFile,
    credentials.map((c) => `${c.role.padEnd(12)} ${c.email.padEnd(40)} ${c.password}   # ${c.fullName}`).join('\n') + '\n',
  );
  console.log(`Cuentas creadas: ${credentials.length}\nCredenciales: ${credFile}`);
  await dataSource.destroy();
}

main().catch((error: unknown) => {
  console.error('Fallo en la limpieza:', error);
  process.exit(1);
});
