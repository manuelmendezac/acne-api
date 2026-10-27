import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Guarda lo que la segunda opinión vio en cada fotografía al subirla: `acne`, `piel_sana` o
 * `indeterminado` (una de otra enfermedad no llega a guardarse: se rechaza al subir).
 *
 * Con `SECOND_OPINION_REQUIRE_ACNE` activo en el motor, un caso no se analiza si ninguna de sus
 * fotografías muestra acné; sin esta columna habría que volver a enviar cada foto a Google al pulsar
 * «Analizar». NULL en las fotografías anteriores o subidas con la regla apagada: no se afirma nada de
 * ellas, y un caso con alguna toma sin lectura no se bloquea.
 */
export class LecturaAcneImagen1759000000000 implements MigrationInterface {
  name = 'LecturaAcneImagen1759000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "imagenes_caso" ADD COLUMN "lectura_acne" varchar(20) NULL
         CONSTRAINT "CHK_imagenes_caso_lectura_acne"
         CHECK ("lectura_acne" IN ('acne', 'piel_sana', 'indeterminado'))`,
    );
    await queryRunner.query(
      `COMMENT ON COLUMN "imagenes_caso"."lectura_acne" IS 'Lo que la segunda opinión (Gemini) vio al subir la foto. Un caso no se analiza si ninguna toma obligatoria dice acne. NULL: sin lectura, no bloquea.'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "imagenes_caso" DROP COLUMN "lectura_acne"`);
  }
}
