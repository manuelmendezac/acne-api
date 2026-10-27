import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { Repository } from 'typeorm';
import { assertCaseActive } from 'src/cases/case-guards';

import { EncryptionService } from 'src/common/crypto/encryption.service';
import { APP_CONFIG, type AppConfig } from 'src/config/configuration';
import { SignedUrlService } from 'src/common/crypto/signed-url.service';
import {
  checkSameSubject,
  checkShotView,
  isAcneCheck,
  isHeadPose,
  isShotKey,
  lacksAcneEvidence,
  missingRequiredShots,
  takesPartInIdentity,
  type AcneCheck,
  type HeadPose,
  type IdentityReading,
  type ShotKey,
  type ShotSibling,
} from 'src/common/domain';
import { readImageDimensions } from 'src/common/utils/image-dimensions';
import { sniffImageType, type SniffedImageType } from 'src/common/utils/image-sniffer';
import { AiEngineClient, type ScreenReference } from 'src/inference/ai-engine.client';
import { STORAGE_PROVIDER, type StorageProvider } from 'src/storage/storage.provider';

import { describeRejection, describeIssues } from './screening-message';

import { CaseImage } from './case-image.entity';
import { CaseImageDto } from './dto/image.dto';

export type { CaseImageDto };

const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

/** The 503 text when the photograph could not be verified: it was NOT stored. */
const UNVERIFIED_MESSAGE =
  'No se pudo verificar la fotografía porque el servicio de análisis de imágenes no respondió. ' +
  'No se guardó; vuelva a intentarlo en unos segundos.';

interface Screening {
  warnings: string[];
  pose: HeadPose | null;
  identity: IdentityReading | null;
  /** What the engine's second opinion saw; null when it did not check. */
  acneCheck: AcneCheck | null;
}

/** Upload warning for an admitted photograph in which the second opinion saw no acne. */
const NO_ACNE_IN_SHOT_WARNING =
  'En esta fotografía no se observa acné. Puede quedar si la zona no tiene lesiones, pero al menos ' +
  'una de las tomas del caso debe mostrarlas para poder analizarlo.';

export interface UploadedImage {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
}

/**
 * Clinical image handling.
 *
 * Covers: RNF-02. Every byte is AES-256-GCM encrypted BEFORE it reaches the storage backend, and
 * is only ever served back through a signed, time-limited, audited endpoint.
 */
@Injectable()
export class ImagesService {
  private readonly logger = new Logger(ImagesService.name);

  constructor(
    @InjectRepository(CaseImage) private readonly repository: Repository<CaseImage>,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
    private readonly encryption: EncryptionService,
    private readonly signedUrl: SignedUrlService,
    private readonly aiEngine: AiEngineClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * @param userId who is credited with the upload. Null only for machine-produced images; a photo
   *   arriving through a mobile capture session is credited to whoever opened that session, so the
   *   audit trail never loses the responsible person.
   * @param shotKey which shot of the photographic protocol this is, when it follows one.
   */
  async upload(
    caseId: string,
    file: UploadedImage,
    userId: string | null,
    shotKey: ShotKey | null = null,
  ): Promise<{ image: CaseImage; warnings: string[] }> {
    await assertCaseActive(this.repository.manager, caseId);
    // The recorded mime type is the sniffed one, not the declared one.
    const mimeType = this.validate(file);
    const siblings = await this.siblings(caseId);
    const screening = await this.screen(
      file.buffer,
      mimeType,
      await this.references(siblings, shotKey),
    );

    const view = checkShotView(
      shotKey,
      screening.pose,
      this.encryption.sha256(file.buffer),
      siblings,
    );
    if (view.rejection !== null) throw new UnprocessableEntityException(view.rejection);
    const subject = checkSameSubject(shotKey, screening.identity);
    if (subject.rejection !== null) throw new UnprocessableEntityException(subject.rejection);

    const image = await this.store(
      caseId,
      file.buffer,
      mimeType,
      userId,
      false,
      shotKey,
      screening.pose,
      screening.acneCheck,
    );
    const acneWarning =
      screening.acneCheck !== null && screening.acneCheck !== 'acne'
        ? [NO_ACNE_IN_SHOT_WARNING]
        : [];
    return {
      image,
      warnings: [...screening.warnings, ...view.warnings, ...subject.warnings, ...acneWarning],
    };
  }

  /**
   * The case's other facial shots, decrypted, for the same-subject comparison: the LAST photograph
   * of each shot (the one that counts everywhere else), never the candidate's own shot, which it
   * replaces. Nothing biometric is kept between requests, so they travel each time (Ley 29733).
   */
  private async references(
    siblings: readonly ShotSibling[],
    shotKey: ShotKey | null,
  ): Promise<ScreenReference[]> {
    if (!this.config.aiEngine.screenUploads || !takesPartInIdentity(shotKey)) return [];
    const latest = new Map<ShotKey, string>();
    for (const sibling of siblings) {
      if (sibling.shotKey === null || sibling.shotKey === shotKey) continue;
      if (takesPartInIdentity(sibling.shotKey)) latest.set(sibling.shotKey, sibling.id);
    }
    const references: ScreenReference[] = [];
    for (const [key, id] of latest) {
      const { data, mimeType } = await this.readPlaintext(id);
      references.push({
        label: key,
        image_base64: data.toString('base64'),
        mime_type: mimeType,
      });
    }
    return references;
  }

  /** The case's photographs as `checkShotView` reads them, oldest first. */
  private async siblings(caseId: string, excludeId?: string): Promise<ShotSibling[]> {
    const images = await this.findByCase(caseId, false);
    return images
      .filter((image) => image.id !== excludeId)
      .map((image) => ({
        id: image.id,
        shotKey: image.shotKey,
        sha256: image.sha256,
        pose: image.pose,
      }));
  }

  /**
   * Refuses anything that is not an evaluable facial photograph, BEFORE it is stored.
   *
   * Rejecting after storing would leave the junk encrypted on disk and in the case file, which is
   * both a privacy cost and the mess this is meant to prevent.
   *
   * WHAT IT DOES NOT CHECK: whether the photograph shows acne. `sin_lesiones` is one of the five
   * IGA classes and a clean face at a follow-up visit is what a resolved case looks like —
   * screening for the disease would reject the evidence that the treatment worked.
   *
   * It runs in BOTH experimental conditions, which is what makes it admissible: a factor held
   * constant on both sides of a paired contrast cannot explain a difference between them. The
   * engine's verdict carries nothing clinical, so nothing about the disease leaks into the pretest
   * (RF-TR-01).
   *
   * FAILS CLOSED since 25/10/2026, by the research team's decision: an engine that is down, that
   * answers `checked: false` or that could not compare identities makes the upload a 503, and
   * nothing is stored. Until then it failed open, and a case could be filed with photographs
   * nobody had verified — two different people among them. Switching screening off
   * (`IMAGE_SCREENING_ENABLED=false`) is the only way to admit unverified images, and it is a
   * deliberate operating mode, not an accident.
   *
   * @param references the case's other shots, compared with this one for the same-subject rule.
   * @returns quality warnings worth passing to the photographer, the head pose, and the identity
   *   reading — pose and identity are null only when screening is switched off.
   */
  private async screen(
    buffer: Buffer,
    mimeType: string,
    references: ScreenReference[] = [],
  ): Promise<Screening> {
    if (!this.config.aiEngine.screenUploads) {
      return { warnings: [], pose: null, identity: null, acneCheck: null };
    }
    let verdict;
    try {
      verdict = await this.aiEngine.screenImage(buffer.toString('base64'), mimeType, references);
    } catch (error: unknown) {
      this.logger.error(
        'No se pudo cribar la imagen; se rechaza la subida: ' +
          (error instanceof Error ? error.message : String(error)),
      );
      throw new ServiceUnavailableException(UNVERIFIED_MESSAGE);
    }
    if (!verdict.checked) {
      this.logger.error('El motor no cribó la imagen (checked: false); se rechaza la subida.');
      throw new ServiceUnavailableException(UNVERIFIED_MESSAGE);
    }
    if (!verdict.acceptable) {
      throw new UnprocessableEntityException(describeRejection(verdict.subject, verdict.reason));
    }
    if (!verdict.identity?.checked) {
      this.logger.error(
        'El motor no pudo comparar la identidad entre tomas; se rechaza la subida.',
      );
      throw new ServiceUnavailableException(UNVERIFIED_MESSAGE);
    }
    return {
      warnings: describeIssues(verdict.issues),
      pose: isHeadPose(verdict.pose) ? verdict.pose : null,
      acneCheck: isAcneCheck(verdict.acne_check) ? verdict.acne_check : null,
      identity: {
        faceFound: verdict.identity.face_found,
        comparisons: verdict.identity.comparisons.flatMap((comparison) =>
          isShotKey(comparison.label)
            ? [
                {
                  shotKey: comparison.label,
                  verdict: comparison.verdict,
                  nearDuplicate: comparison.near_duplicate,
                },
              ]
            : [],
        ),
      },
    };
  }

  /** Persists a Grad-CAM overlay produced by the engine (section 8.4). */
  async storeHeatmap(caseId: string, data: Buffer, mimeType: string): Promise<CaseImage> {
    return this.store(caseId, data, mimeType, null, true, null, null);
  }

  private async store(
    caseId: string,
    plaintext: Buffer,
    mimeType: string,
    userId: string | null,
    isHeatmap: boolean,
    shotKey: ShotKey | null,
    pose: HeadPose | null,
    acneCheck: AcneCheck | null = null,
  ): Promise<CaseImage> {
    const dimensions = readImageDimensions(plaintext);
    // The digest is of the PLAINTEXT, so integrity can be checked after decryption.
    const sha256 = this.encryption.sha256(plaintext);
    const key = `${isHeatmap ? 'heatmaps' : 'cases'}/${caseId}/${randomUUID()}.enc`;

    await this.storage.put(
      key,
      this.encryption.encryptBuffer(plaintext),
      'application/octet-stream',
    );

    const image = this.repository.create({
      caseId,
      storageKey: key,
      storageDriver: this.storage.driver,
      mimeType,
      width: dimensions?.width ?? null,
      height: dimensions?.height ?? null,
      sizeBytes: String(plaintext.length),
      sha256,
      encrypted: true,
      isHeatmap,
      uploadedBy: userId,
      shotKey,
      pose,
      acneCheck,
    });
    return this.repository.save(image);
  }

  async findById(id: string): Promise<CaseImage> {
    const image = await this.repository.findOne({ where: { id } });
    if (image === null) throw new NotFoundException(`No existe la imagen ${id}.`);
    return image;
  }

  /**
   * Corrige la toma de una fotografía ya subida.
   *
   * La etiqueta es lo que el protocolo mínimo comprueba, y el mostrador se equivoca de desplegable
   * con facilidad: tres fotografías subidas como «Vista general» son, en la práctica, una general y
   * dos perfiles mal rotulados. Reetiquetar no toca los bytes ni el cifrado y no invalida nada que
   * dependa de la imagen (una inferencia mira píxeles, no la etiqueta), así que no tiene las
   * restricciones de `remove`. Un mapa de calor no es una toma y no se reetiqueta.
   *
   * Pasa por las mismas reglas de vista que la subida (`checkShotView`), con la orientación que se
   * midió al subirla: reetiquetar no puede ser la puerta de atrás para archivar un perfil como
   * vista general. Y por la misma comprobación de identidad (`checkSameSubject`) contra las demás
   * tomas: un acercamiento sin rostro comparable no puede pasar a ser un perfil sin verificar.
   */
  async relabel(imageId: string, shotKey: ShotKey): Promise<CaseImage> {
    const image = await this.findById(imageId);
    if (image.isHeatmap) {
      throw new BadRequestException('Un mapa de calor no es una toma del protocolo fotográfico.');
    }
    await assertCaseActive(this.repository.manager, image.caseId);
    const siblings = await this.siblings(image.caseId, image.id);
    const view = checkShotView(shotKey, image.pose, image.sha256, siblings);
    if (view.rejection !== null) throw new UnprocessableEntityException(view.rejection);
    if (this.config.aiEngine.screenUploads && takesPartInIdentity(shotKey)) {
      const { data, mimeType } = await this.readPlaintext(image.id);
      const screening = await this.screen(data, mimeType, await this.references(siblings, shotKey));
      const subject = checkSameSubject(shotKey, screening.identity);
      if (subject.rejection !== null) throw new UnprocessableEntityException(subject.rejection);
    }
    await this.repository.update({ id: imageId }, { shotKey });
    image.shotKey = shotKey;
    return image;
  }

  /**
   * Retira una fotografía subida por error, con sus bytes.
   *
   * Se BORRA de verdad, no se marca: una imagen clínica que nadie leyó nunca es un dato personal
   * que ya no hace falta, y conservarla «por si acaso» es exactamente lo que la Ley N.º 29733 pide
   * no hacer. Lo que queda es el asiento de auditoría, que dice quién la quitó y cuándo (RNF-05).
   *
   * Se niega en dos casos, y ninguno es burocracia:
   *
   *  - **La miró el modelo.** La inferencia y su mapa de calor son una lectura DE esta fotografía;
   *    sin ella la sugerencia queda sin sustento y el caso muestra una clase IGA que ya no se
   *    puede contrastar contra nada.
   *  - **El especialista ya diagnosticó.** La fotografía es la evidencia sobre la que firmó. Que
   *    desaparezca después convierte un diagnóstico verificable en la palabra de alguien.
   *
   * En ambos casos la salida real es subir la fotografía correcta: el caso admite varias, y quien
   * revisa elige cuál mira.
   */
  async remove(imageId: string): Promise<{ removed: boolean; caseId: string }> {
    const image = await this.findById(imageId);

    if (image.isHeatmap) {
      throw new BadRequestException(
        'El mapa de calor no se retira por separado: lo produjo el modelo al leer una fotografía, ' +
          'y borrarlo dejaría la inferencia sin la superposición que la explica.',
      );
    }

    const [used] = await this.repository.manager.query<Array<{ n: string }>>(
      `SELECT COUNT(*) AS "n" FROM "inferencias_ia" WHERE "imagen_id" = $1`,
      [imageId],
    );
    if (Number(used?.n ?? 0) > 0) {
      throw new BadRequestException(
        'Esta fotografía ya fue analizada por el modelo y la inferencia se apoya en ella. Suba la ' +
          'fotografía correcta y analícela: el caso admite varias, y quien revisa elige cuál mira.',
      );
    }

    const [graded] = await this.repository.manager.query<Array<{ n: string }>>(
      `SELECT COUNT(*) AS "n" FROM "diagnosticos" WHERE "caso_id" = $1`,
      [image.caseId],
    );
    if (Number(graded?.n ?? 0) > 0) {
      throw new BadRequestException(
        'El caso ya tiene un diagnóstico firmado y esta fotografía es parte de la evidencia sobre ' +
          'la que se firmó. No se puede retirar.',
      );
    }

    // La fila primero: si cayera el almacenamiento, un objeto huérfano cifrado es basura; una fila
    // que apunta a bytes inexistentes es una imagen rota en la ficha de un paciente.
    await this.repository.delete({ id: imageId });
    try {
      await this.storage.remove(image.storageKey);
    } catch (error: unknown) {
      this.logger.warn(
        `La imagen ${imageId} se retiró del caso pero sus bytes siguen en el almacenamiento: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return { removed: true, caseId: image.caseId };
  }

  /**
   * Borra del almacenamiento los bytes cifrados de fotografías cuyas filas ya no existen (el caso se
   * borró y sus `imagenes_caso` se fueron en cascada). Un fallo no deshace nada: un objeto cifrado
   * huérfano es basura, no un dato expuesto; queda en el log para limpiarlo.
   */
  async purgeStoredBytes(storageKeys: readonly string[]): Promise<void> {
    for (const key of storageKeys) {
      try {
        await this.storage.remove(key);
      } catch (error: unknown) {
        this.logger.warn(
          `No se pudieron borrar los bytes de ${key}: ` +
            (error instanceof Error ? error.message : String(error)),
        );
      }
    }
  }

  /**
   * Required shots of the photographic protocol the case still lacks.
   *
   * Heatmaps are the model's output, not a photograph of the patient, and photographs uploaded
   * without a shot label cannot be credited to any view — both are ignored (see
   * `missingRequiredShots`).
   */
  async missingRequiredShots(caseId: string): Promise<ShotKey[]> {
    const images = await this.findByCase(caseId, false);
    return missingRequiredShots(images.map((image) => image.shotKey));
  }

  /**
   * Whether the case must not be analysed because none of its required shots shows acne, by what
   * the second opinion saw at upload (`lacksAcneEvidence`).
   */
  async lacksAcneEvidence(caseId: string): Promise<boolean> {
    return lacksAcneEvidence(await this.findByCase(caseId, false));
  }

  async findByCase(caseId: string, includeHeatmaps = false): Promise<CaseImage[]> {
    const where = includeHeatmaps ? { caseId } : { caseId, isHeatmap: false };
    return this.repository.find({ where, order: { createdAt: 'ASC' } });
  }

  /**
   * Verifies the signed token, decrypts and returns the plaintext bytes.
   * The caller is responsible for writing the audit entry (RNF-02).
   */
  async readContent(imageId: string, token: string): Promise<{ data: Buffer; mimeType: string }> {
    const issuedTo = this.signedUrl.verify(token, imageId);
    if (issuedTo === null) {
      throw new UnauthorizedException(
        'El enlace de la imagen es inválido o ha expirado. Los enlaces firmados caducan a los 15 minutos (RNF-02).',
      );
    }
    return this.readPlaintext(imageId);
  }

  /**
   * Server-side read with no signed token, for the inference worker.
   *
   * Not reachable from any HTTP route: the only callers are internal services that already run
   * under a verified request, so exposing it does not widen the surface protected by RNF-02.
   */
  async readPlaintext(imageId: string): Promise<{ data: Buffer; mimeType: string }> {
    const image = await this.findById(imageId);
    const stored = await this.storage.get(image.storageKey);
    const data = image.encrypted ? this.encryption.decryptBuffer(stored) : stored;

    if (this.encryption.sha256(data) !== image.sha256) {
      throw new BadRequestException(
        'La imagen almacenada no coincide con su huella SHA-256 registrada: posible corrupción o alteración.',
      );
    }
    return { data, mimeType: image.mimeType };
  }

  toDto(image: CaseImage, apiPrefix: string, userId: string): CaseImageDto {
    return {
      id: image.id,
      caseId: image.caseId,
      mimeType: image.mimeType,
      width: image.width,
      height: image.height,
      sizeBytes: Number(image.sizeBytes),
      sha256: image.sha256,
      encrypted: image.encrypted,
      isHeatmap: image.isHeatmap,
      shotKey: image.shotKey,
      acneCheck: image.acneCheck,
      createdAt: image.createdAt.toISOString(),
      url: this.signedUrl.buildUrl(apiPrefix, image.id, userId),
    };
  }

  /**
   * @returns the mime type read from the file's own bytes, which is what gets recorded.
   *
   * The declared `mimetype` is checked first only to give a clearer message; the binding decision is
   * the sniff. A phone's camera app labels its output inconsistently, and the mobile upload route is
   * authorised by a QR token rather than by a session, so the header cannot be trusted.
   */
  private validate(file: UploadedImage): SniffedImageType {
    if (file.buffer.length === 0) {
      throw new BadRequestException('El archivo de imagen está vacío.');
    }
    if (file.buffer.length > MAX_IMAGE_BYTES) {
      throw new BadRequestException(
        `La imagen supera el máximo de ${MAX_IMAGE_BYTES / (1024 * 1024)} MB.`,
      );
    }

    const sniffed = sniffImageType(file.buffer);
    if (sniffed === null) {
      const declared = (ALLOWED_MIME_TYPES as readonly string[]).includes(file.mimetype)
        ? `El archivo dice ser ${file.mimetype}, pero su contenido no lo es.`
        : `Formato no admitido (${file.mimetype}).`;
      throw new BadRequestException(
        `${declared} Use una fotografía JPEG, PNG o WebP completa; si la tomó con el teléfono, vuelva a intentarlo con mejor señal.`,
      );
    }
    return sniffed;
  }
}
