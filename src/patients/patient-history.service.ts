import { Inject, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { AnamnesisService } from 'src/anamnesis/anamnesis.service';
import { SignedUrlService } from 'src/common/crypto/signed-url.service';
import {
  AI_VIEWER_ROLES,
  IGA_ORDINAL,
  type CaseStatus,
  type IgaClass,
  type AcneCheck,
  type ShotKey,
  type StudyMode,
} from 'src/common/domain';
import type { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';
import { APP_CONFIG, type AppConfig } from 'src/config/configuration';
import type { CaseImageDto } from 'src/images/dto/image.dto';

import type {
  HistoryDiagnosisDto,
  HistoryEntryDto,
  HistoryInferenceDto,
  HistoryTimingDto,
  PatientHistoryDto,
  PatientHistorySummaryDto,
} from './dto/patient-history.dto';
import type { PatientResponseDto } from './dto/patient.dto';

/**
 * Builds the longitudinal record of a patient.
 *
 * Assembled from five small queries and joined in memory rather than as one wide join: a single
 * query across cases × diagnoses × timings × images multiplies rows and the de-duplication is
 * harder to get right than the assembly.
 */
@Injectable()
export class PatientHistoryService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly anamnesisService: AnamnesisService,
    private readonly signedUrl: SignedUrlService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async build(
    patient: PatientResponseDto,
    user: AuthenticatedUser,
    includeSynthetic: boolean,
  ): Promise<PatientHistoryDto> {
    // The AI block follows the REQUESTER's role and condition, exactly as the case view does:
    // during the pretest pass the physician must not glimpse the model's opinion, not even in a
    // history screen, and the intake desk never sees it at all (RF-TR-01, RF-TR-02).
    const aiVisible = AI_VIEWER_ROLES.includes(user.role);

    const cases = await this.dataSource.query<RawCase[]>(
      `SELECT c."id", c."codigo_caso" AS "caseCode", c."estado_codigo" AS "status", c."modo_estudio_codigo" AS "studyMode",
              c."clase_iga_referencia" AS "groundTruthIga", c."es_sintetico" AS "isSynthetic",
              c."creado_en" AS "createdAt", c."cerrado_en" AS "closedAt"
         FROM "casos" c
        WHERE c."paciente_id" = $1
          AND ($2::boolean OR c."es_sintetico" = false)
          AND c."anulado_en" IS NULL
        ORDER BY c."creado_en" ASC`,
      [patient.id, includeSynthetic],
    );

    if (cases.length === 0) {
      return { patient, summary: this.emptySummary(), timeline: [] };
    }

    const caseIds = cases.map((c) => c.id);

    const [diagnoses, timings, inferences, images] = await Promise.all([
      this.dataSource.query<RawDiagnosis[]>(
        `SELECT d."id", d."caso_id" AS "caseId", d."modo_estudio_codigo" AS "studyMode",
                d."clase_iga_codigo" AS "igaClass", d."puntaje_gags" AS "gagsScore", d."notas",
                d."creado_en" AS "createdAt", u."nombre_completo" AS "professional"
           FROM "diagnosticos" d
           JOIN "usuarios" u ON u."id" = d."usuario_id"
          WHERE d."caso_id" = ANY($1)
          ORDER BY d."creado_en" ASC`,
        [caseIds],
      ),
      this.dataSource.query<RawTiming[]>(
        `SELECT t."caso_id" AS "caseId", t."modo_estudio_codigo" AS "studyMode", t."t0",
                t."duracion_segundos" AS "durationSeconds", t."valido"
           FROM "cronometrajes_revision" t
          WHERE t."caso_id" = ANY($1)
          ORDER BY t."t0" ASC`,
        [caseIds],
      ),
      aiVisible
        ? this.dataSource.query<RawInference[]>(
            `SELECT DISTINCT ON (i."caso_id")
                    i."id" AS "inferenceId",
                    i."caso_id" AS "caseId", i."clase_iga_codigo" AS "igaClass", i."confianza",
                    i."version_modelo" AS "modelVersion", i."backend_modelo" AS "modelBackend",
                    i."creado_en" AS "createdAt"
               FROM "inferencias_ia" i
              WHERE i."caso_id" = ANY($1) AND i."estado_codigo" = 'exitoso'
              ORDER BY i."caso_id", i."creado_en" DESC`,
            [caseIds],
          )
        : Promise.resolve([] as RawInference[]),
      this.dataSource.query<RawImage[]>(
        `SELECT im."id", im."caso_id" AS "caseId", im."tipo_mime" AS "mimeType",
                im."ancho", im."alto", im."tamano_bytes" AS "sizeBytes", im."sha256",
                im."cifrada", im."es_mapa_calor" AS "isHeatmap", im."toma_codigo" AS "shotKey", im."lectura_acne" AS "acneCheck",
                im."creado_en" AS "createdAt"
           FROM "imagenes_caso" im
          WHERE im."caso_id" = ANY($1)
            AND ($2::boolean OR im."es_mapa_calor" = false)
          ORDER BY im."creado_en" ASC`,
        [caseIds, aiVisible],
      ),
    ]);

    // The anamnesis is NOT gated by study mode: it must look identical in pretest and postest, or
    // the paired contrast would be measuring "anamnesis + IA" instead of the intervention alone.
    const anamnesis = await this.anamnesisService.summariesForCases(caseIds);

    // Se pide DESPUÉS y no dentro del `Promise.all`: la valoración cuelga de la inferencia, y sus
    // identificadores no se conocen hasta que la consulta anterior vuelve.
    const assessments = await this.assessmentsFor(inferences.map((i) => i.inferenceId));

    const apiPrefix = `/${this.config.globalPrefix}`;
    const timeline: HistoryEntryDto[] = cases.map((row) => {
      const caseDiagnoses = diagnoses
        .filter((d) => d.caseId === row.id)
        .map((d): HistoryDiagnosisDto => ({
          id: d.id,
          studyMode: d.studyMode,
          igaClass: d.igaClass,
          gagsScore: d.gagsScore,
          notes: d.notes,
          professional: d.professional,
          createdAt: new Date(d.createdAt).toISOString(),
        }));

      const inference = inferences.find((i) => i.caseId === row.id);

      return {
        caseId: row.id,
        caseCode: row.caseCode,
        status: row.status,
        studyMode: row.studyMode,
        groundTruthIga: row.groundTruthIga,
        isSynthetic: row.isSynthetic,
        createdAt: new Date(row.createdAt).toISOString(),
        closedAt: row.closedAt === null ? null : new Date(row.closedAt).toISOString(),
        // The clinically binding severity of the visit is the specialist's latest judgement, not
        // the model's suggestion and not the consensus label used for the study metrics.
        severity: caseDiagnoses.length === 0 ? null : (caseDiagnoses.at(-1)?.igaClass ?? null),
        diagnoses: caseDiagnoses,
        timings: timings
          .filter((t) => t.caseId === row.id)
          .map((t): HistoryTimingDto => ({
            studyMode: t.studyMode,
            t0: new Date(t.t0).toISOString(),
            reviewMinutes: t.durationSeconds === null ? null : t.durationSeconds / 60,
            valid: t.valid,
          })),
        inference:
          inference === undefined
            ? null
            : ({
                igaClass: inference.igaClass,
                confidence: inference.confidence,
                modelVersion: inference.modelVersion,
                modelBackend: inference.modelBackend,
                createdAt: new Date(inference.createdAt).toISOString(),
                assessment: assessments.get(inference.inferenceId) ?? null,
              } satisfies HistoryInferenceDto),
        images: images
          .filter((im) => im.caseId === row.id)
          .map((im): CaseImageDto => ({
            id: im.id,
            caseId: im.caseId,
            mimeType: im.mimeType,
            width: im.width,
            height: im.height,
            sizeBytes: Number(im.sizeBytes),
            sha256: im.sha256,
            encrypted: im.encrypted,
            isHeatmap: im.isHeatmap,
            shotKey: im.shotKey,
            acneCheck: im.acneCheck,
            createdAt: new Date(im.createdAt).toISOString(),
            url: this.signedUrl.buildUrl(apiPrefix, im.id, user.id),
          })),
        anamnesis: anamnesis.get(row.id) ?? null,
      };
    });

    return { patient, summary: this.summarise(timeline), timeline };
  }

  /**
   * Las lecturas razonadas de un puñado de inferencias, indexadas por inferencia.
   *
   * Dos consultas y no una por visita: la cabecera de la valoración y sus renglones ordenados. Un
   * `ANY($1)` sobre una lista corta cuesta lo mismo que sobre una sola, y el historial de un
   * paciente con doce visitas haría veinticuatro viajes a la base por nada.
   */
  private async assessmentsFor(
    inferenceIds: string[],
  ): Promise<Map<string, HistoryInferenceDto['assessment']>> {
    const result = new Map<string, HistoryInferenceDto['assessment']>();
    if (inferenceIds.length === 0) return result;

    const [headers, details] = await Promise.all([
      this.dataSource.query<Array<{ inferenceId: string; summary: string; rationale: string }>>(
        `SELECT v."inferencia_id" AS "inferenceId", v."resumen" AS "summary",
                v."fundamento_severidad" AS "rationale"
           FROM "valoraciones_inferencia" v
          WHERE v."inferencia_id" = ANY($1)`,
        [inferenceIds],
      ),
      this.dataSource.query<Array<{ inferenceId: string; type: string; text: string }>>(
        `SELECT d."inferencia_id" AS "inferenceId", d."tipo_codigo" AS "type", d."texto" AS "text"
           FROM "detalles_valoracion" d
          WHERE d."inferencia_id" = ANY($1)
          ORDER BY d."orden" ASC`,
        [inferenceIds],
      ),
    ]);

    for (const header of headers) {
      const own = details.filter((detail) => detail.inferenceId === header.inferenceId);
      const listOf = (type: string): string[] =>
        own.filter((detail) => detail.type === type).map((detail) => detail.text);
      result.set(header.inferenceId, {
        summary: header.summary,
        severityRationale: header.rationale,
        lesionTypes: listOf('lesion'),
        affectedZones: listOf('zona'),
        differentials: listOf('diferencial'),
        considerations: listOf('consideracion'),
        anamnesisFlags: listOf('bandera_anamnesis'),
      });
    }
    return result;
  }

  private summarise(timeline: HistoryEntryDto[]): PatientHistorySummaryDto {
    const graded = timeline.filter((entry) => entry.severity !== null);
    const first = graded[0]?.severity ?? null;
    const last = graded.at(-1)?.severity ?? null;

    const reviewMinutes = timeline
      .flatMap((entry) => entry.timings)
      .filter((timing) => timing.valid && timing.reviewMinutes !== null)
      .map((timing) => timing.reviewMinutes as number);

    let trend = 'sin_datos';
    let severityDelta: number | null = null;
    if (first !== null && last !== null && graded.length >= 2) {
      // IGA is ordinal and lower is better, so a negative delta is an improvement.
      severityDelta = IGA_ORDINAL[last] - IGA_ORDINAL[first];
      trend = severityDelta < 0 ? 'mejora' : severityDelta > 0 ? 'empeora' : 'estable';
    }

    return {
      totalCases: timeline.length,
      closedCases: timeline.filter((entry) => entry.status === 'cerrado').length,
      firstVisitAt: timeline[0]?.createdAt ?? null,
      lastVisitAt: timeline.at(-1)?.createdAt ?? null,
      firstSeverity: first,
      lastSeverity: last,
      trend,
      severityDelta,
      totalReviews: timeline.reduce((acc, entry) => acc + entry.timings.length, 0),
      averageReviewMinutes:
        reviewMinutes.length === 0
          ? null
          : Math.round((reviewMinutes.reduce((a, b) => a + b, 0) / reviewMinutes.length) * 100) /
            100,
    };
  }

  private emptySummary(): PatientHistorySummaryDto {
    return {
      totalCases: 0,
      closedCases: 0,
      firstVisitAt: null,
      lastVisitAt: null,
      firstSeverity: null,
      lastSeverity: null,
      trend: 'sin_datos',
      severityDelta: null,
      totalReviews: 0,
      averageReviewMinutes: null,
    };
  }
}

interface RawCase {
  id: string;
  caseCode: string;
  status: CaseStatus;
  studyMode: StudyMode;
  groundTruthIga: IgaClass | null;
  isSynthetic: boolean;
  createdAt: string;
  closedAt: string | null;
}

interface RawDiagnosis {
  id: string;
  caseId: string;
  studyMode: StudyMode;
  igaClass: IgaClass;
  gagsScore: number | null;
  notes: string | null;
  createdAt: string;
  professional: string;
}

interface RawTiming {
  caseId: string;
  studyMode: StudyMode;
  t0: string;
  durationSeconds: number | null;
  valid: boolean;
}

interface RawInference {
  inferenceId: string;
  caseId: string;
  igaClass: IgaClass | null;
  confidence: number | null;
  modelVersion: string;
  modelBackend: string;
  createdAt: string;
}

interface RawImage {
  id: string;
  caseId: string;
  mimeType: string;
  width: number | null;
  height: number | null;
  sizeBytes: string;
  sha256: string;
  encrypted: boolean;
  isHeatmap: boolean;
  shotKey: ShotKey | null;
  acneCheck: AcneCheck | null;
  createdAt: string;
}
