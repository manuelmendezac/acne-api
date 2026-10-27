import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, IsNull, Repository } from 'typeorm';
import { assertCaseActive } from 'src/cases/case-guards';

import {
  REQUIRED_SHOT_KEYS,
  IGA_LABELS,
  aggregateViews,
  caseVerdictOf,
  viewsForSuggestion,
  buildCaseReading,
  describeMissingShots,
  NO_ACNE_EVIDENCE_MESSAGE,
  describeRule,
  isIgaClass,
  isShotKey,
  shotLabel,
  type AnamnesisAnswer,
  type ClinicalAssessment,
  type IgaClass,
} from 'src/common/domain';

import { AnamnesisAnswerRepository } from 'src/anamnesis/anamnesis-answer.repository';
import { AnamnesisService } from 'src/anamnesis/anamnesis.service';
import { APP_CONFIG, type AppConfig } from 'src/config/configuration';
import { ImagesService } from 'src/images/images.service';
import { QuestionsService } from 'src/questions/questions.service';

import { AiInference } from './ai-inference.entity';
import { fromSecondOpinionColumns, toSecondOpinionColumns } from './second-opinion';
import { ChosenReading } from './chosen-reading.entity';
import { AiEngineClient } from './ai-engine.client';
import { AssessmentDetail, type AssessmentDetailType } from './assessment-detail.entity';
import { InferenceAssessment } from './inference-assessment.entity';
import { InferenceMember } from './inference-member.entity';
import { InferenceProbability } from './inference-probability.entity';
import { buildClinicalContext, type PatientContextRow } from './clinical-context';
import {
  AiInferenceDto,
  CaseAnalysisDto,
  CaseAnalysisViewDto,
  CaseReadingSelectionDto,
  ChooseReadingDto,
} from './dto/inference.dto';
import { QUEUE_PROVIDER, type QueueProvider } from './queue/queue.provider';

export type { AiInferenceDto };

/**
 * Child tables every read of an inference needs.
 *
 * They are not optional detail: `classProbs` and `assessment` are part of the DTO the case screen
 * renders, and loading the header alone would silently return an inference with no probability
 * vector and no reasoning — which reads as "the model said nothing" rather than as a bug.
 */
const RELATIONS = ['probabilities', 'assessmentRow', 'assessmentRow.details', 'members'];

/**
 * Orchestrates CNN inference: enqueue, drain, persist.
 *
 * Covers: OE2 (RF-OE2-01) and section 9.2 (`inference/`).
 *
 * Inference is asynchronous on purpose. Making the physician's request block on the model would
 * fold the engine's latency into TRi and contaminate the OE1 measurement with something that is
 * not medical review time.
 */
@Injectable()
export class InferenceService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(InferenceService.name);
  private timer: NodeJS.Timeout | null = null;
  private draining = false;
  private readonly startedAt = Date.now();

  constructor(
    @InjectRepository(AiInference) private readonly repository: Repository<AiInference>,
    @InjectRepository(ChosenReading) private readonly choices: Repository<ChosenReading>,
    @Inject(QUEUE_PROVIDER) private readonly queue: QueueProvider,
    private readonly aiEngine: AiEngineClient,
    private readonly imagesService: ImagesService,
    private readonly anamnesisAnswers: AnamnesisAnswerRepository,
    private readonly anamnesisService: AnamnesisService,
    private readonly questions: QuestionsService,
    private readonly dataSource: DataSource,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.drain();
    }, this.config.queue.pollIntervalMs);
    this.logger.log(
      `Worker de inferencia activo (driver=${this.queue.driver}, intervalo=${this.config.queue.pollIntervalMs} ms).`,
    );
  }

  onModuleDestroy(): void {
    if (this.timer !== null) clearInterval(this.timer);
  }

  /**
   * Creates the pending inference row and enqueues the job. Idempotent per (case, image) unless
   * `force` is set, which queues a fresh reading even when one exists — the way to re-read a case
   * after the served model changed. Old rows are kept; the case analysis takes the newest.
   *
   * Refuses a case that lacks any required shot of the photographic protocol: the model reads one
   * image, and a grade issued on a face the clinician cannot see from both sides is a grade nobody
   * can check.
   */
  async request(
    caseId: string,
    imageId: string,
    userId: string,
    force = false,
  ): Promise<AiInference> {
    await assertCaseActive(this.dataSource.manager, caseId);
    const missing = await this.imagesService.missingRequiredShots(caseId);
    if (missing.length > 0) throw new BadRequestException(describeMissingShots(missing));
    if (await this.imagesService.lacksAcneEvidence(caseId)) {
      throw new BadRequestException(NO_ACNE_EVIDENCE_MESSAGE);
    }

    if (!force) {
      const existing = await this.repository.findOne({
        where: { caseId, imageId },
        order: { createdAt: 'DESC' },
      });
      if (existing !== null && existing.status !== 'fallido') return existing;
    }

    const inference = await this.repository.save(
      this.repository.create({
        caseId,
        imageId,
        status: 'pendiente',
        modelVersion: 'pending',
        modelBackend: 'unknown',
        seed: 42,
      }),
    );
    await this.queue.enqueue({ caseId, imageId, requestedBy: userId });
    return inference;
  }

  /**
   * Analyse the whole case: one inference per required shot, latest photograph of each.
   *
   * The protocol's three views are the unit the grade is meant for; analysing only the last
   * upload graded one cheek. Idempotent like `request`: a view whose inference already exists
   * and did not fail is not re-queued, unless `force` asks for a fresh reading of every view.
   */
  async requestForCase(caseId: string, userId: string, force = false): Promise<AiInference[]> {
    await assertCaseActive(this.dataSource.manager, caseId);
    const missing = await this.imagesService.missingRequiredShots(caseId);
    if (missing.length > 0) throw new BadRequestException(describeMissingShots(missing));
    if (await this.imagesService.lacksAcneEvidence(caseId)) {
      throw new BadRequestException(NO_ACNE_EVIDENCE_MESSAGE);
    }

    const images = await this.imagesService.findByCase(caseId, false);
    const latestPerShot = new Map<string, (typeof images)[number]>();
    for (const image of images) {
      if (image.shotKey !== null && REQUIRED_SHOT_KEYS.includes(image.shotKey)) {
        latestPerShot.set(image.shotKey, image); // findByCase is chronological: last wins
      }
    }
    const results: AiInference[] = [];
    for (const key of REQUIRED_SHOT_KEYS) {
      const image = latestPerShot.get(key);
      if (image !== undefined) {
        results.push(await this.request(caseId, image.id, userId, force));
      }
    }
    return results;
  }

  /**
   * Record which reading the clinician wants as the case suggestion.
   *
   * The inference must belong to the case, have succeeded and be the latest for its image — a
   * choice over a superseded reading would silently point at numbers nobody can see any more.
   * With `memberTag`, that model's vote within the view is the reading; without it, the view's
   * ensemble reading. Replaces any previous choice for the case.
   */
  async chooseReading(
    caseId: string,
    dto: ChooseReadingDto,
    userId: string,
  ): Promise<CaseReadingSelectionDto> {
    const inference = await this.repository.findOne({
      where: { id: dto.inferenceId, caseId },
      relations: RELATIONS,
    });
    if (inference === null) throw new NotFoundException('La inferencia no pertenece a este caso.');
    if (inference.status !== 'exitoso') {
      throw new BadRequestException('Solo puede elegirse una lectura terminada con éxito.');
    }
    const latest = await this.repository.findOne({
      where: { caseId, imageId: inference.imageId },
      order: { createdAt: 'DESC' },
    });
    if (latest !== null && latest.id !== inference.id) {
      throw new BadRequestException(
        'Esa lectura fue reemplazada por un análisis más reciente; elija sobre el análisis vigente.',
      );
    }
    const memberTag =
      dto.memberTag === undefined || dto.memberTag === null || dto.memberTag === ''
        ? null
        : dto.memberTag;
    if (memberTag !== null && !(inference.members ?? []).some((m) => m.tag === memberTag)) {
      throw new BadRequestException(`La toma no tiene una lectura del modelo «${memberTag}».`);
    }
    // A history, never a slot: the previous choice is withdrawn, not overwritten.
    await this.choices.update(
      { caseId, withdrawnAt: IsNull() },
      { withdrawnAt: new Date(), withdrawnById: userId },
    );
    await this.choices.save(
      this.choices.create({
        caseId,
        inferenceId: inference.id,
        memberTag,
        reason:
          dto.reason === undefined || dto.reason === null || dto.reason.trim() === ''
            ? null
            : dto.reason.trim(),
        userId,
        chosenAt: new Date(),
        withdrawnAt: null,
        withdrawnById: null,
      }),
    );
    const analysis = await this.caseAnalysis(caseId);
    return analysis.selection as CaseReadingSelectionDto;
  }

  /** Back to the automatic rule: withdraws the active choice. Returns whether there was one. */
  async withdrawReading(caseId: string, userId: string): Promise<boolean> {
    const result = await this.choices.update(
      { caseId, withdrawnAt: IsNull() },
      { withdrawnAt: new Date(), withdrawnById: userId },
    );
    return (result.affected ?? 0) > 0;
  }

  /** The stored choice, resolved against the current views; `null` when there is none. */
  private async selectionFor(
    caseId: string,
    views: CaseAnalysisViewDto[],
  ): Promise<CaseReadingSelectionDto | null> {
    const choice = await this.choices.findOne({
      where: { caseId, withdrawnAt: IsNull() },
      order: { chosenAt: 'DESC' },
      relations: ['user'],
    });
    if (choice === null) return null;
    const view = views.find((v) => v.inference.id === choice.inferenceId) ?? null;
    const member =
      view === null || choice.memberTag === null
        ? null
        : ((view.inference.members ?? []).find((m) => m.tag === choice.memberTag) ?? null);
    const source = member ?? view?.inference ?? null;
    const active =
      view !== null &&
      view.inference.status === 'exitoso' &&
      (choice.memberTag === null || member !== null);
    return {
      inferenceId: choice.inferenceId,
      imageId: view?.imageId ?? '',
      shotKey: view?.shotKey ?? null,
      memberTag: choice.memberTag,
      igaClass: active ? (source?.igaClass ?? null) : null,
      confidence: active ? (source?.confidence ?? null) : null,
      reason: choice.reason,
      chosenByName: choice.user?.fullName ?? null,
      chosenAt: choice.chosenAt.toISOString(),
      active,
    };
  }

  /**
   * The case-level reading: latest inference of each clinical photograph, combined.
   *
   * Computed on read, never stored — it is a function of the per-image rows, which are the
   * evidence. The mean of the per-view probability vectors is the case suggestion; `agreement`
   * says whether the views voted alike. Only the required shots take part in the mean, so an
   * optional close-up does not outweigh a profile.
   */
  async caseAnalysis(caseId: string): Promise<CaseAnalysisDto> {
    const [inferences, images] = await Promise.all([
      this.repository.find({
        where: { caseId },
        order: { createdAt: 'ASC' },
        relations: RELATIONS,
      }),
      this.imagesService.findByCase(caseId, false),
    ]);
    const shotOf = new Map(images.map((image) => [image.id, image.shotKey]));
    const latestPerImage = new Map<string, AiInference>();
    for (const inference of inferences) latestPerImage.set(inference.imageId, inference);

    const views: CaseAnalysisViewDto[] = [];
    for (const image of images) {
      const inference = latestPerImage.get(image.id);
      if (inference === undefined) continue;
      views.push({
        imageId: image.id,
        shotKey: shotOf.get(image.id) ?? null,
        inference: this.toDto(inference),
      });
    }

    const done = views.filter((v) => v.inference.status === 'exitoso');
    // A view the gate declared another condition has nothing to grade: it is left out of the
    // suggestion. A healthy view is set aside as soon as another view shows acne — its
    // `sin_lesiones` carries the gate's probability, not a grade, and must not outvote the
    // lesions on the other cheek (see `viewsForSuggestion`). Only when no view is gradable does
    // the case become `no_acne`; when every gradable view is healthy skin, `piel_sana`.
    const noAcneViews = done.filter((v) => v.inference.verdict === 'no_acne').map((v) => v.imageId);
    const { pool: graded, healthySetAside } = viewsForSuggestion(
      done.map((v) => ({ ...v, verdict: v.inference.verdict })),
    );
    const healthyViewsSetAside = healthySetAside.map((v) => v.imageId);
    const caseVerdict = caseVerdictOf(done.map((v) => v.inference.verdict));
    const counted = graded.filter(
      (v) =>
        v.shotKey !== null &&
        REQUIRED_SHOT_KEYS.includes(v.shotKey) &&
        v.inference.classProbs !== null,
    );
    const pool =
      counted.length > 0 ? counted : graded.filter((v) => v.inference.classProbs !== null);

    const verdict = aggregateViews(
      pool.map((v) => ({
        imageId: v.imageId,
        shotKey: v.shotKey,
        igaClass: v.inference.igaClass as IgaClass,
        confidence: v.inference.confidence ?? 0,
        classProbs: v.inference.classProbs ?? {},
      })),
    );
    const shotOfView = (imageId: string): string | null =>
      views.find((v) => v.imageId === imageId)?.shotKey ?? null;
    const labelOf = (key: string | null): string =>
      key === null ? 'sin toma' : isShotKey(key) ? shotLabel(key) : key;
    let ruleDescription = describeRule(verdict, labelOf, shotOfView);

    // A clinician's choice overrides the rule while it points at a current reading.
    const selection = await this.selectionFor(caseId, views);
    if (selection !== null && selection.active && selection.igaClass !== null) {
      const chosenView = views.find((v) => v.inference.id === selection.inferenceId);
      const chosenMember =
        selection.memberTag === null
          ? null
          : ((chosenView?.inference.members ?? []).find((m) => m.tag === selection.memberTag) ??
            null);
      verdict.igaClass = selection.igaClass;
      verdict.confidence = selection.confidence;
      verdict.classProbs = chosenMember?.classProbs ?? chosenView?.inference.classProbs ?? null;
      verdict.rule = 'seleccion_manual';
      verdict.decidedBy = chosenView === undefined ? [] : [chosenView.imageId];
      ruleDescription =
        `Lectura elegida por ${selection.chosenByName ?? 'el equipo'}: ` +
        `${labelOf(selection.shotKey)}` +
        (selection.memberTag === null ? ' (ensemble)' : ` (${selection.memberTag})`) +
        ` → ${IGA_LABELS[selection.igaClass].toLowerCase()}` +
        (selection.reason !== null && selection.reason.trim() !== ''
          ? `. Motivo: ${selection.reason.trim()}`
          : '.');
    }
    const { igaClass, confidence, classProbs, agreement } = verdict;

    let reading: ClinicalAssessment | null = null;
    if (igaClass !== null) {
      const [answers, profile] = await Promise.all([
        this.anamnesisService.answersForCase(caseId).catch(() => ({})),
        this.anamnesisService.profileForCase(caseId).catch(() => ({ sex: null, ageYears: null })),
      ]);
      reading = buildCaseReading({
        igaClass,
        confidence,
        agreement,
        rule: verdict.rule,
        ruleDescription,
        decidedBy: verdict.decidedBy,
        range: verdict.range,
        views: pool.map((v) => ({
          imageId: v.imageId,
          shotKey: v.shotKey,
          igaClass: v.inference.igaClass,
          confidence: v.inference.confidence,
          members: (v.inference.members ?? []).map((m) => ({
            tag: m.tag,
            igaClass: m.igaClass,
            confidence: m.confidence,
          })),
        })),
        answers,
        ageYears: profile.ageYears,
        sex: profile.sex,
      });
    }

    return {
      igaClass,
      confidence,
      classProbs,
      agreement,
      rule: verdict.rule,
      ruleDescription,
      decidedBy: verdict.decidedBy,
      range: verdict.range,
      selection,
      reading,
      verdict: caseVerdict,
      noAcneViews,
      healthyViewsSetAside,
      completed: done.length,
      pending: views.filter(
        (v) => v.inference.status === 'pendiente' || v.inference.status === 'ejecutando',
      ).length,
      failed: views.filter((v) => v.inference.status === 'fallido').length,
      views,
    };
  }

  async findByCase(caseId: string): Promise<AiInference | null> {
    return this.repository.findOne({
      where: { caseId },
      order: { createdAt: 'DESC' },
      relations: RELATIONS,
    });
  }

  async findById(id: string): Promise<AiInference> {
    const inference = await this.repository.findOne({ where: { id }, relations: RELATIONS });
    if (inference === null) throw new NotFoundException(`No existe la inferencia ${id}.`);
    return inference;
  }

  async queueStatus(): Promise<Record<string, number>> {
    return this.queue.countByStatus();
  }

  /** Drains one job per tick, keeping the API responsive under a single-process deployment. */
  /**
   * Un turno del obrero, con plazo.
   *
   * `draining` existe para que dos turnos no se pisen, y por eso mismo es peligroso: si un turno
   * no termina nunca, la cola queda muerta hasta reiniciar la API, en silencio y con la pantalla
   * diciendo «el modelo está leyendo el caso». Ocurrió de verdad, contra una base remota que se
   * vuelve inalcanzable a media consulta. El plazo garantiza que el guardia siempre se suelta.
   */
  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    const budget = this.config.queue.leaseMs + 30_000;
    try {
      await this.withDeadline(
        this.drainOnce(),
        budget,
        `El turno del obrero de inferencia superó ${Math.round(budget / 1000)} s; se suelta la cola.`,
      );
    } catch (error: unknown) {
      this.logger.error(`Error al drenar la cola de inferencia: ${String(error)}`);
    } finally {
      this.draining = false;
    }
  }

  private async drainOnce(): Promise<void> {
    await this.expireAbandoned();
    const job = await this.queue.claimNext();
    if (job === null) return;

    /*
     * Traza de una sola línea por trabajo, y no es ruido.
     *
     * Un análisis que se queda «pendiente» sin un solo renglón en el registro no se puede
     * diagnosticar: no se sabe si el obrero llegó a tomarlo, si murió en la base o si el motor no
     * contestó. Con esto, el registro dice al menos que empezó y con qué.
     */
    this.logger.log(
      `Analizando el caso ${job.caseId} (imagen ${job.imageId}, intento ${job.attempts}/${job.maxAttempts}).`,
    );
    const startedAt = Date.now();

    try {
      // Con plazo: un trabajo que no termina nunca se lleva por delante el turno entero. Al vencer
      // se trata como un fallo normal, que es lo que es, y vuelve a la cola si le quedan intentos.
      const inference = await this.withDeadline(
        this.execute(job.caseId, job.imageId),
        this.config.queue.leaseMs,
        `El análisis del caso ${job.caseId} superó ${Math.round(this.config.queue.leaseMs / 1000)} s sin terminar.`,
      );
      await this.queue.complete(job.jobId, inference.id);
      this.logger.log(
        `Caso ${job.caseId} analizado en ${Date.now() - startedAt} ms ` +
          `(backend=${inference.modelBackend}, clase=${inference.igaClass ?? '—'}).`,
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Inferencia fallida para el caso ${job.caseId} (intento ${job.attempts}/${job.maxAttempts}): ${message}`,
      );
      await this.queue.fail(job.jobId, message);
      // Both statuses must be reachable here: `execute` moves the row to `running` before it
      // can fail, so filtering on `pending` alone would leave every failed inference stuck in
      // `running` forever, invisible to the portal and to the IIA error rate.
      await this.repository.update(
        { caseId: job.caseId, imageId: job.imageId, status: In(['pendiente', 'ejecutando']) },
        { status: 'fallido', errorMessage: message.slice(0, 2000) },
      );
    }
  }

  /**
   * Cierra las inferencias cuyos trabajos quedaron abandonados sin intentos restantes.
   *
   * Una inferencia eternamente `pendiente` es peor que una fallida: la segunda se puede reintentar
   * desde la pantalla, la primera solo parece una cola lenta.
   */
  private async expireAbandoned(): Promise<void> {
    const abandoned = await this.queue.expireStale();
    for (const job of abandoned) {
      this.logger.warn(
        `El trabajo ${job.jobId} quedó abandonado y agotó sus intentos; se marca fallida la ` +
          `inferencia del caso ${job.caseId}.`,
      );
      await this.repository.update(
        { caseId: job.caseId, imageId: job.imageId, status: In(['pendiente', 'ejecutando']) },
        {
          status: 'fallido',
          errorMessage:
            'El análisis quedó a medias (el proceso o la conexión con la base se cortaron) y ' +
            'agotó sus reintentos. Puede volver a pedirlo desde el caso.',
        },
      );
    }
  }

  /**
   * Una etapa del análisis, con su nombre en el error si se tuerce.
   *
   * Sin esto, un análisis atascado solo decía «pendiente»: no se distinguía una base que no
   * contesta de un motor que no contesta, y son dos averías con dos arreglos distintos.
   */
  private async stage<T>(what: string, caseId: string, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`No se pudo ${what} del caso ${caseId}: ${message}`);
    }
  }

  /**
   * Resuelve la promesa o se rinde al vencer el plazo.
   *
   * No cancela lo que quedó en marcha —una promesa no se cancela—, pero suelta al obrero, que es
   * lo que importa: el trabajo vuelve a la cola y la cola sigue viva.
   */
  private async withDeadline<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(message)), ms);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async execute(caseId: string, imageId: string): Promise<AiInference> {
    // Second line of defence against a malformed job: a TypeORM `where` built from undefined
    // values drops those conditions and would match an unrelated inference.
    if (
      typeof caseId !== 'string' ||
      caseId === '' ||
      typeof imageId !== 'string' ||
      imageId === ''
    ) {
      throw new Error(
        `Trabajo de inferencia inválido (caseId="${caseId}", imageId="${imageId}"): se descarta ` +
          'sin tocar ninguna inferencia existente.',
      );
    }

    const inference = await this.stage('leer la inferencia', caseId, () =>
      this.repository.findOneOrFail({ where: { caseId, imageId }, order: { createdAt: 'DESC' } }),
    );
    await this.stage('marcarla en curso', caseId, () =>
      this.repository.update({ id: inference.id }, { status: 'ejecutando' }),
    );

    const { data, mimeType } = await this.stage('descifrar la imagen', caseId, () =>
      this.imagesService.readPlaintext(imageId),
    );
    const context = await this.stage('leer la anamnesis', caseId, () =>
      this.clinicalContext(caseId),
    );
    const result = await this.stage('consultar el motor', caseId, () =>
      this.aiEngine.inferSingle(data.toString('base64'), mimeType, caseId, context),
    );

    let heatmapImageId: string | null = null;
    if (result.heatmap_png_base64 !== null) {
      const heatmap = await this.imagesService.storeHeatmap(
        caseId,
        Buffer.from(result.heatmap_png_base64, 'base64'),
        'image/png',
      );
      heatmapImageId = heatmap.id;
    }

    // Every member's Grad-CAM is filed like the lead one: the physician can switch between them
    // and each stays attached to the model that produced it.
    const members = result.members ?? [];
    const memberHeatmaps: Array<string | null> = [];
    for (const member of members) {
      if (member.heatmap_png_base64 === null) {
        memberHeatmaps.push(null);
        continue;
      }
      const stored = await this.imagesService.storeHeatmap(
        caseId,
        Buffer.from(member.heatmap_png_base64, 'base64'),
        'image/png',
      );
      memberHeatmaps.push(stored.id);
    }

    // `no_acne` is a successful answer, not a failure: the gate looked and found nothing to grade.
    // It is stored without class, GAGS or probabilities, and is never retried. `piel_sana` is
    // stored like a graded reading: `sin_lesiones` with the gate's probability as its vector.
    const verdict = result.verdict ?? 'acne';
    const graded = verdict !== 'no_acne';
    const prediction = graded ? result.prediction : null;
    const gags = graded ? result.gags_secondary : null;
    if (graded && (prediction === null || gags === null)) {
      throw new Error(
        `El motor respondió «${verdict}» sin clase IGA ni GAGS: respuesta incompleta.`,
      );
    }

    // Cabecera e hijas en una sola transacción: una inferencia marcada exitosa cuyo vector de
    // probabilidades no llegó a escribirse le mostraría al médico una clase sin su respaldo.
    await this.dataSource.transaction(async (manager) => {
      await manager.getRepository(AiInference).update(
        { id: inference.id },
        {
          status: 'exitoso',
          verdict,
          verdictSource: result.verdict_source ?? 'filtro',
          acneProbability: result.acne_probability ?? null,
          gateVersion: result.gate_version ?? null,
          ...toSecondOpinionColumns(result.second_opinion),
          igaClass: prediction?.iga_class ?? null,
          confidence: prediction?.confidence ?? null,
          gagsGrade: gags?.grade ?? null,
          gagsScore: gags?.score ?? null,
          heatmapImageId,
          latencyMs: result.latency_ms,
          modelVersion: result.model_version,
          modelBackend: result.model_backend,
          weightsChecksum: result.weights_checksum,
          seed: result.seed,
          agreement: result.agreement ?? null,
          errorMessage: null,
        },
      );

      const memberRepository = manager.getRepository(InferenceMember);
      await memberRepository.delete({ inferenceId: inference.id });
      if (members.length > 0) {
        await memberRepository.insert(
          members.map((member, index) => ({
            inferenceId: inference.id,
            position: index,
            tag: member.tag,
            modelName: member.model_name,
            modelVersion: member.model_version,
            weightsChecksum: member.weights_checksum,
            weight: member.weight,
            igaClass: member.iga_class,
            confidence: member.confidence,
            classProbs: member.class_probs,
            heatmapImageId: memberHeatmaps[index] ?? null,
            latencyMs: member.latency_ms,
          })),
        );
      }

      const probabilities = manager.getRepository(InferenceProbability);
      await probabilities.delete({ inferenceId: inference.id });
      if (prediction !== null) {
        await probabilities.insert(
          Object.entries(prediction.class_probs)
            .filter(([igaClass]) => isIgaClass(igaClass))
            .map(([igaClass, probability]) => ({
              inferenceId: inference.id,
              igaClass: igaClass as IgaClass,
              probability,
            })),
        );
      }

      // Un reintento sobre la misma fila reemplaza la lectura anterior; el CASCADE de
      // `detalles_valoracion` se lleva sus renglones.
      await manager.getRepository(InferenceAssessment).delete({ inferenceId: inference.id });
      if (result.assessment !== null) {
        await manager.getRepository(InferenceAssessment).insert({
          inferenceId: inference.id,
          summary: result.assessment.summary,
          severityRationale: result.assessment.severity_rationale,
        });
        const details: Array<Partial<AssessmentDetail>> = [];
        const lists: Array<[AssessmentDetailType, readonly string[]]> = [
          ['lesion', result.assessment.lesion_types],
          ['zona', result.assessment.affected_zones],
          ['diferencial', result.assessment.differentials],
          ['consideracion', result.assessment.considerations],
          ['bandera_anamnesis', result.assessment.anamnesis_flags],
        ];
        for (const [type, texts] of lists) {
          texts.forEach((text, index) => {
            details.push({ inferenceId: inference.id, type, position: index, text });
          });
        }
        if (details.length > 0) await manager.getRepository(AssessmentDetail).insert(details);
      }
    });

    return this.findById(inference.id);
  }

  /**
   * The anamnesis of the case, as anonymised context for a backend that can reason over text.
   *
   * Read here and not in `request()` because the history keeps being filled in while the job waits
   * in the queue: taking it at execution time is what makes the model see the record as it stands
   * when it actually looks at the photograph.
   *
   * A failure to read it must never fail the inference — the questionnaire is an extension with no
   * numbered requirement behind it, while the grading is OE2. The model then works from the image
   * alone, which is exactly what it does for a case with no anamnesis at all.
   */
  private async clinicalContext(caseId: string): Promise<ReturnType<typeof buildClinicalContext>> {
    try {
      const [row] = await this.dataSource.query<
        Array<PatientContextRow & { anamnesisId: string | null }>
      >(
        `SELECT p."sexo_codigo" AS "sex", p."fecha_nacimiento" AS "birthDate",
                p."fototipo_codigo" AS "phototype", a."id" AS "anamnesisId"
           FROM "casos" c
           JOIN "pacientes" p ON p."id" = c."paciente_id"
           LEFT JOIN "anamnesis_caso" a ON a."caso_id" = c."id"
          WHERE c."id" = $1`,
        [caseId],
      );
      if (row === undefined) return null;
      const answers: Record<string, AnamnesisAnswer> | null =
        row.anamnesisId === null ? null : await this.anamnesisAnswers.read(row.anamnesisId);
      // El catálogo vivo, no la constante semilla: una pregunta creada desde el portal se responde
      // y se archiva igual que las demás, y tiene que llegar al modelo igual que las demás.
      return buildClinicalContext(row, answers, await this.questions.catalogue());
    } catch (error: unknown) {
      this.logger.warn(
        `No se pudo leer la anamnesis del caso ${caseId}; se infiere solo con la imagen: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * Latency and error statistics of the last 24 hours, as measured by the orchestrator itself.
   * Feeds `GET /audit/iia-check` (RF-TR-04) and the RNF-01 latency budget.
   */
  async latencyStats24h(): Promise<{
    count: number;
    medianMs: number | null;
    p95Ms: number | null;
    errorRate: number;
    uptimeHours: number;
  }> {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const rows = await this.repository
      .createQueryBuilder('inference')
      .select('inference.latencyMs', 'latency')
      .addSelect('inference.status', 'status')
      .where('inference.createdAt >= :since', { since })
      .getRawMany<{ latency: number | null; status: string }>();

    const latencies = rows
      .filter((r) => r.status === 'exitoso' && r.latency !== null)
      .map((r) => r.latency as number)
      .sort((a, b) => a - b);

    const failed = rows.filter((r) => r.status === 'fallido').length;

    return {
      count: rows.length,
      medianMs: this.quantile(latencies, 0.5),
      p95Ms: this.quantile(latencies, 0.95),
      errorRate: rows.length === 0 ? 0 : failed / rows.length,
      uptimeHours: (Date.now() - this.startedAt) / 3_600_000,
    };
  }

  toDto(inference: AiInference): AiInferenceDto {
    return {
      id: inference.id,
      caseId: inference.caseId,
      imageId: inference.imageId,
      status: inference.status,
      verdict: inference.verdict ?? 'acne',
      verdictSource: inference.verdictSource ?? 'filtro',
      acneProbability: inference.acneProbability ?? null,
      secondOpinion: fromSecondOpinionColumns(inference),
      igaClass: inference.igaClass,
      confidence: inference.confidence,
      classProbs: toClassProbs(inference.probabilities),
      gagsGrade: inference.gagsGrade,
      gagsScore: inference.gagsScore,
      heatmapImageId: inference.heatmapImageId,
      latencyMs: inference.latencyMs,
      modelVersion: inference.modelVersion,
      modelBackend: inference.modelBackend,
      weightsChecksum: inference.weightsChecksum,
      seed: inference.seed,
      assessment: toAssessment(inference.assessmentRow),
      agreement: inference.agreement,
      members: [...(inference.members ?? [])]
        .sort((a, b) => a.position - b.position)
        .map((member) => ({
          tag: member.tag,
          modelName: member.modelName,
          modelVersion: member.modelVersion,
          weightsChecksum: member.weightsChecksum,
          weight: member.weight,
          igaClass: member.igaClass,
          confidence: member.confidence,
          classProbs: member.classProbs,
          heatmapImageId: member.heatmapImageId,
          latencyMs: member.latencyMs,
        })),
      errorMessage: inference.errorMessage,
      createdAt: inference.createdAt.toISOString(),
    };
  }

  private quantile(sorted: number[], q: number): number | null {
    if (sorted.length === 0) return null;
    const index = Math.min(sorted.length - 1, Math.floor(sorted.length * q));
    return sorted[index] ?? null;
  }
}

/**
 * Rebuilds the probability vector the portal expects from the rows of
 * `probabilidades_inferencia`.
 *
 * `null` and `{}` are different answers and both occur: a pending or failed inference has no
 * vector at all, while a succeeded one always has five rows. Collapsing the first into an empty
 * object would draw a bar chart of zeros where the honest UI shows nothing.
 */
function toClassProbs(
  probabilities: InferenceProbability[] | undefined,
): Record<string, number> | null {
  if (probabilities === undefined || probabilities.length === 0) return null;
  return Object.fromEntries(probabilities.map((row) => [row.igaClass, row.probability]));
}

/** Rebuilds the reasoned reading from its header row and its five ordered detail lists. */
function toAssessment(
  assessment: InferenceAssessment | null | undefined,
): ClinicalAssessment | null {
  if (assessment === null || assessment === undefined) return null;
  const details = assessment.details ?? [];
  const listOf = (type: AssessmentDetailType): string[] =>
    details
      .filter((detail) => detail.type === type)
      .sort((a, b) => a.position - b.position)
      .map((detail) => detail.text);

  return {
    summary: assessment.summary,
    lesionTypes: listOf('lesion'),
    affectedZones: listOf('zona'),
    severityRationale: assessment.severityRationale,
    differentials: listOf('diferencial'),
    considerations: listOf('consideracion'),
    anamnesisFlags: listOf('bandera_anamnesis'),
  };
}
