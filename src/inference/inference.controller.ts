import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';

import { AuditService } from 'src/audit/audit.service';
import { CurrentUser, Roles } from 'src/common/decorators';
import type {
  AuthenticatedRequest,
  AuthenticatedUser,
} from 'src/common/interfaces/authenticated-user';

import {
  ChooseReadingDto,
  InferenceTimesDto,
  type CaseAnalysisDto,
  type CaseReadingSelectionDto,
} from './dto/inference.dto';
import type { AiInferenceDto } from './inference.service';
import { InferenceService } from './inference.service';
import { AI_VIEWER_ROLES, ANALYSIS_ROLES, CONTRAST_ROLES } from 'src/common/domain';

/**
 * Covers: OE2 and RF-TR-01.
 *
 * La IA está disponible para todo rol que pueda verla: desde que el pretest es la evaluación
 * user whose `study_mode` is `pretest`. This is the enforceable half of the independent-variable
 * lock: the pretest observation stays uncontaminated even if a client tries to call the endpoint.
 */
@ApiTags('inference')
@ApiBearerAuth()
@Controller('inference')
export class InferenceController {
  constructor(
    private readonly inferenceService: InferenceService,
    private readonly auditService: AuditService,
  ) {}

  @Post('case/:caseId/image/:imageId')
  @Roles(...AI_VIEWER_ROLES, 'admin')
  @ApiOperation({
    summary: 'Encola la inferencia CNN de una imagen (bloqueado en pretest).',
    description:
      'Devuelve 403 cuando el usuario opera en modo pretest (IIA = 0), por RF-TR-01. ' +
      'La inferencia es asíncrona para que la latencia del modelo no se sume al tiempo de ' +
      'revisión médica que mide OE1.',
  })
  async request(
    @Param('caseId', ParseUUIDPipe) caseId: string,
    @Param('imageId', ParseUUIDPipe) imageId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<AiInferenceDto> {
    const inference = await this.inferenceService.request(caseId, imageId, user.id);
    await this.auditService.record(
      user,
      {
        action: 'inference.request',
        entityType: 'ai_inference',
        entityId: inference.id,
        metadata: { caseId, imageId },
      },
      request,
    );
    return this.inferenceService.toDto(inference);
  }

  @Post('case/:caseId')
  @Roles(...AI_VIEWER_ROLES, 'admin')
  @ApiOperation({
    summary: 'Analiza el caso completo: encola la inferencia de cada toma obligatoria.',
    description:
      'Vista general y ambos perfiles, con la última fotografía de cada toma. Idempotente: una ' +
      'toma ya inferida con éxito no se vuelve a encolar, salvo con `force=true`, que encola una ' +
      'lectura nueva de cada toma (p. ej. tras cambiar el modelo servido). 400 si falta alguna ' +
      'toma obligatoria.',
  })
  @ApiQuery({ name: 'force', required: false, type: Boolean })
  async requestForCase(
    @Param('caseId', ParseUUIDPipe) caseId: string,
    @Query('force') force: string | undefined,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<AiInferenceDto[]> {
    const inferences = await this.inferenceService.requestForCase(
      caseId,
      user.id,
      force === 'true',
    );
    for (const inference of inferences) {
      await this.auditService.record(
        user,
        {
          action: 'inference.request',
          entityType: 'ai_inference',
          entityId: inference.id,
          metadata: { caseId, imageId: inference.imageId, scope: 'case' },
        },
        request,
      );
    }
    return inferences.map((inference) => this.inferenceService.toDto(inference));
  }

  @Get('case/:caseId/analysis')
  @Roles(...AI_VIEWER_ROLES, 'admin')
  @ApiOperation({
    summary: 'Análisis del caso: la inferencia de cada toma y la sugerencia combinada.',
  })
  async caseAnalysis(@Param('caseId', ParseUUIDPipe) caseId: string): Promise<CaseAnalysisDto> {
    return this.inferenceService.caseAnalysis(caseId);
  }

  @Put('case/:caseId/selection')
  @Roles(...AI_VIEWER_ROLES, 'admin')
  @ApiOperation({
    summary: 'Elige la lectura (toma y, opcionalmente, modelo) que vale como sugerencia del caso.',
    description:
      'Sustituye a la regla automática mientras la inferencia elegida sea la vigente de su ' +
      'imagen. La clase elegida es la que alimenta la comprobación anamnesis↔imagen y la ficha ' +
      'de diagnóstico. Queda auditado con quién, cuándo y por qué.',
  })
  async chooseReading(
    @Param('caseId', ParseUUIDPipe) caseId: string,
    @Body() dto: ChooseReadingDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<CaseReadingSelectionDto> {
    const selection = await this.inferenceService.chooseReading(caseId, dto, user.id);
    await this.auditService.record(
      user,
      {
        action: 'analysis.select',
        entityType: 'case',
        entityId: caseId,
        metadata: {
          inferenceId: selection.inferenceId,
          imageId: selection.imageId,
          shotKey: selection.shotKey,
          memberTag: selection.memberTag,
          igaClass: selection.igaClass,
          reason: selection.reason,
        },
      },
      request,
    );
    return selection;
  }

  @Post('case/:caseId/selection/withdraw')
  @HttpCode(204)
  @Roles(...AI_VIEWER_ROLES, 'admin')
  @ApiOperation({
    summary: 'Retira la lectura elegida: el caso vuelve a la regla automática.',
    description:
      'No borra nada: la elección queda en el historial con quién y cuándo la retiró ' +
      '(`lecturas_elegidas.retirada_en`).',
  })
  async withdrawReading(
    @Param('caseId', ParseUUIDPipe) caseId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    const removed = await this.inferenceService.withdrawReading(caseId, user.id);
    if (removed) {
      await this.auditService.record(
        user,
        { action: 'analysis.unselect', entityType: 'case', entityId: caseId, metadata: {} },
        request,
      );
    }
  }

  @Get('case/:caseId')
  @Roles(...AI_VIEWER_ROLES, 'admin')
  @ApiOperation({ summary: 'Devuelve la última inferencia de un caso (bloqueado en pretest).' })
  async findByCase(
    @Param('caseId', ParseUUIDPipe) caseId: string,
  ): Promise<AiInferenceDto | null> {
    const inference = await this.inferenceService.findByCase(caseId);
    return inference === null ? null : this.inferenceService.toDto(inference);
  }

  @Get('queue/status')
  @Roles(...CONTRAST_ROLES)
  @ApiOperation({ summary: 'Estado de la cola de inferencia por estado de trabajo.' })
  async queueStatus(): Promise<Record<string, number>> {
    return this.inferenceService.queueStatus();
  }

  @Get('times')
  @Roles(...ANALYSIS_ROLES)
  @ApiQuery({
    name: 'hasta',
    required: false,
    type: String,
    description: 'Último código de caso incluido, p. ej. ACN-2026-0030. Sin él, todos los casos.',
  })
  @ApiOperation({
    summary: 'Tiempo de inferencia por caso: motor completo, solo ensemble y reloj de pared.',
    description:
      'Sobre los casos reales analizados, con la última lectura exitosa de cada fotografía. Es ' +
      'el «tiempo medio de inferencia por caso» de la tesis; los tiempos van en ms.',
  })
  async times(@Query('hasta') hasta?: string): Promise<InferenceTimesDto> {
    const until = hasta?.trim() ?? '';
    if (until !== '' && !/^[A-Z]{3}-\d{4}-\d{4,}$/.test(until)) {
      throw new BadRequestException(`«${until}» no es un código de caso (ACN-2026-0030).`);
    }
    return this.inferenceService.caseTimes(until === '' ? null : until);
  }
}
