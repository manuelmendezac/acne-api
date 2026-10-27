import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

import { ACNE_CHECKS, SHOT_KEYS, type AcneCheck, type ShotKey } from 'src/common/domain';

/**
 * Clinical image as returned to the portal.
 *
 * A class rather than an interface because the OpenAPI document — from which `acne-web` generates
 * its typed client — can only describe what it can introspect. An interface would come out of the
 * generator as an empty object and the frontend would silently lose its types.
 */
export class CaseImageDto {
  @ApiProperty() id: string;
  @ApiProperty() caseId: string;
  @ApiProperty() mimeType: string;
  @ApiProperty({ nullable: true, type: Number }) width: number | null;
  @ApiProperty({ nullable: true, type: Number }) height: number | null;
  @ApiProperty() sizeBytes: number;
  @ApiProperty({ description: 'SHA-256 del plaintext, para verificar integridad tras descifrar.' })
  sha256: string;
  @ApiProperty() encrypted: boolean;
  @ApiProperty({ description: 'True para superposiciones Grad-CAM.' }) isHeatmap: boolean;
  @ApiProperty({
    nullable: true,
    enum: SHOT_KEYS,
    description:
      'Toma del protocolo fotográfico. Null en las imágenes anteriores al protocolo y en las ' +
      'sintéticas del seeder, que no lo siguieron.',
  })
  shotKey: ShotKey | null;
  @ApiProperty({
    nullable: true,
    enum: ACNE_CHECKS,
    type: String,
    description:
      'Lo que la segunda opinión vio al subir la foto. El caso no se analiza si ninguna toma ' +
      'obligatoria dice `acne`. Null: no se verificó (regla apagada o foto anterior).',
  })
  acneCheck: AcneCheck | null;
  @ApiProperty() createdAt: string;
  @ApiProperty({ description: 'URL firmada con TTL de 15 minutos (RNF-02).' }) url: string;
}

/**
 * What a successful upload returns.
 *
 * `warnings` is how a photograph that WAS accepted still tells the person who took it what to do
 * better — bad light, a face out of frame. They never block: rejecting a usable clinical photograph
 * over its framing would cost more than it saves.
 */
export class UploadedImageDto extends CaseImageDto {
  @ApiProperty({
    type: [String],
    description: 'Avisos de calidad de la fotografía admitida. No bloquean la subida.',
  })
  warnings: string[];
}

/** Body of `POST /images/:id/shot`: which view of the protocol an uploaded photograph is. */
export class RelabelImageDto {
  @ApiProperty({
    enum: SHOT_KEYS,
    description:
      'Toma del protocolo fotográfico. Cambiarla no toca los bytes ni el cifrado: solo corrige ' +
      'qué vista es, que es lo que las tomas obligatorias comprueban.',
  })
  @IsIn([...SHOT_KEYS])
  shotKey: ShotKey;
}
