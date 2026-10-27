import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';

import type { GagsGrade, IgaClass } from 'src/common/domain';
import { APP_CONFIG, type AppConfig } from 'src/config/configuration';

/**
 * Typed client of `acne-ai-engine`.
 *
 * The response shapes mirror section 9.1 of the specification verbatim. They can be regenerated
 * from the engine's own OpenAPI document with `pnpm generate:ai-types`, which is the contract rule
 * of section 4: no hand-written duplicate of another service's schema.
 */

/**
 * The anamnesis that travels with the photograph.
 *
 * Carries no identity. RF-TR-03 reserves the patient's name and document for the treating
 * dermatologist, and neither is needed to read a photograph — so neither is sent, least of all to a
 * backend that may forward it to a third party.
 */
export interface ClinicalContextPayload {
  age: number | null;
  sex: string | null;
  phototype: string | null;
  answers: Array<{ question: string; answer: string }>;
}

/** The reasoned reading behind a grade. Null when the backend only looks at pixels. */
export interface ClinicalAssessment {
  summary: string;
  lesion_types: string[];
  affected_zones: string[];
  severity_rationale: string;
  differentials: string[];
  considerations: string[];
  anamnesis_flags: string[];
}

/** One model's vote inside the ensemble (section 8.1, revision 17/09/2026). */
export interface MemberPrediction {
  tag: string;
  model_name: string;
  model_version: string;
  weights_checksum: string;
  weight: number;
  iga_class: IgaClass;
  confidence: number;
  class_probs: Record<string, number>;
  heatmap_png_base64: string | null;
  latency_ms: number;
}

export type EnsembleAgreement = 'unanime' | 'mayoria' | 'discrepancia';

/**
 * What the engine's gate saw before grading:
 * - `acne`: graded by the IGA ensemble;
 * - `piel_sana`: healthy skin (freckles included); the reading is `sin_lesiones` with the GATE's
 *   probability, the ensemble did not run (no members, no Grad-CAM);
 * - `no_acne`: another condition (vitiligo, psoriasis…); NOT graded.
 */
export type AcneVerdict = 'acne' | 'piel_sana' | 'no_acne';

/** Who decided `verdict`: the local gate, or the second opinion when it saw another condition. */
export type VerdictSource = 'filtro' | 'segunda_opinion';

/** What the advisory second opinion saw (see `SecondOpinionOut` in the engine). */
export type SecondOpinionLabel = 'acne' | 'piel_sana' | 'otra_condicion' | 'indeterminado';

export interface SecondOpinion {
  label: SecondOpinionLabel;
  /** Conditions other than acne that it named, most evident first. Empty when none. */
  conditions: string[];
  explanation: string;
  /** Model and prompt revision, e.g. `gemini/gemini-2.5-flash/c1`. */
  version: string;
}

export interface InferSingleResponse {
  /** Absent from engines older than the gate, which graded everything: read as `acne`. */
  verdict?: AcneVerdict;
  /** Absent from engines older than the second opinion: read as `filtro`. */
  verdict_source?: VerdictSource;
  /** False when no gate is loaded: `verdict` is then `acne` by default, not by verification. */
  gate_checked?: boolean;
  acne_probability?: number | null;
  gate_threshold?: number | null;
  gate_version?: string | null;
  /** Probability of each gate label (`acne`, `sana`, `otra`); null without a gate. */
  gate_probabilities?: Record<string, number> | null;
  /** Null only when `verdict` is `no_acne`. */
  prediction: {
    iga_class: IgaClass;
    confidence: number;
    class_probs: Record<string, number>;
  } | null;
  gags_secondary: { grade: GagsGrade; score: number } | null;
  assessment: ClinicalAssessment | null;
  /** Grad-CAM overlay, base64-encoded PNG (section 8.4). */
  heatmap_png_base64: string | null;
  latency_ms: number;
  model_version: string;
  model_backend: 'stub' | 'torch' | 'gemini';
  weights_checksum: string | null;
  seed: number;
  /** Individual readings when the engine serves an ensemble; empty with a single model. */
  members?: MemberPrediction[];
  agreement?: EnsembleAgreement | null;
  /**
   * Advisory second opinion, taken before grading for images the gate let through as acne. It
   * never changes `verdict`. Null or absent when it is off, was not consulted, or failed.
   */
  second_opinion?: SecondOpinion | null;
}

/**
 * Verdict on whether an image may be filed as a clinical photograph.
 *
 * There is deliberately NOTHING clinical here — no severity, no lesion count, no IGA class. The
 * check runs at intake, which happens in both experimental conditions, so anything it revealed
 * about the disease would put the intervention into the pretest and break RF-TR-01.
 */
export interface ImageScreenResponse {
  acceptable: boolean;
  /** False when the active backend cannot examine images. `acceptable` then means "not checked". */
  checked: boolean;
  subject: string;
  /** Quality problems. They warn; on their own they never block. */
  issues: string[];
  reason: string;
  /**
   * Head pose — geometry only. `nariz_*` is the side of the IMAGE the nose points to. Absent from
   * engines older than the pose check.
   */
  pose?: 'frontal' | 'nariz_derecha' | 'nariz_izquierda' | 'indeterminado';
  yaw_ratio?: number | null;
  /**
   * Comparison with the case's other shots: same person, not the same picture re-sent. Null when
   * the image was refused; absent from engines older than the check, which acne-api treats as
   * "not verified".
   */
  identity?: IdentityCheck | null;
  /**
   * What the second opinion saw in an admitted photograph, with `SECOND_OPINION_REQUIRE_ACNE` on.
   * Stored on the image; a case where no required shot says `acne` is not analysed. Null or absent
   * when the rule is off or the image was refused.
   */
  acne_check?: 'acne' | 'piel_sana' | 'otra_condicion' | 'indeterminado' | null;
  latency_ms: number;
  model_backend: 'stub' | 'torch' | 'gemini';
}

/** A photograph already in the case, sent so the candidate can be compared with it. */
export interface ScreenReference {
  label: string;
  image_base64: string;
  mime_type: string;
}

export interface IdentityCheck {
  /** False when the verifier is unavailable or failed. Never a pass. */
  checked: boolean;
  /** The candidate shows a face clear enough to compare. */
  face_found: boolean;
  comparisons: Array<{
    label: string;
    /** `sin_rostro`: the REFERENCE has no comparable face. */
    verdict: 'misma' | 'distinta' | 'sin_rostro';
    similarity: number | null;
    threshold: number | null;
    near_duplicate: boolean;
  }>;
  version: string | null;
}

export interface IiaCheckResponse {
  operational: boolean;
  model_backend: 'stub' | 'torch' | 'gemini';
  /** Why the check passes or fails; `operational` alone cannot distinguish a stub from an LLM. */
  model_kind: 'stub' | 'cnn' | 'llm_externo';
  version: string;
  weights_checksum: string | null;
  latency_median_24h_ms: number | null;
  latency_p95_24h_ms: number | null;
  error_rate_24h: number;
  uptime_hours: number;
  inferences_24h: number;
  seed: number;
  checked_at: string;
  warnings: string[];
}

export interface ModelEvalResponse {
  accuracy: number;
  f1_macro: number;
  auc_roc_macro: number | null;
  confusion_matrix: number[][];
  per_class_metrics: Array<{
    iga_class: IgaClass;
    support: number;
    precision: number;
    recall: number;
    specificity: number;
    f1: number;
  }>;
  dataset_version: string;
  split: string;
  model_version: string;
  run_id: string | null;
  note: string | null;
}

export interface PairedTestRequest {
  design: 'paired' | 'one_sample';
  alpha: number;
  alternative: 'two-sided' | 'less' | 'greater';
  pretest: number[];
  postest?: number[];
  baseline?: number;
  seed: number;
}

export interface PairedTestResponse {
  normality: {
    test: 'shapiro-wilk';
    statistic: number;
    p_value: number;
    normal: boolean;
    applicable: boolean;
    note: string | null;
  };
  test_applied: 'ttest_rel' | 'wilcoxon' | 'ttest_1samp' | 'wilcoxon_1samp';
  statistic: number;
  p_value: number;
  effect_size: {
    kind: 'cohens_dz' | 'rank_biserial';
    value: number;
    magnitude: 'trivial' | 'small' | 'medium' | 'large';
  } | null;
  function_version: string;
}

@Injectable()
export class AiEngineClient {
  private readonly logger = new Logger(AiEngineClient.name);

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async inferSingle(
    imageBase64: string,
    mimeType: string,
    caseCode: string,
    clinicalContext: ClinicalContextPayload | null = null,
  ): Promise<InferSingleResponse> {
    return this.post<InferSingleResponse>('/infer/single', {
      image_base64: imageBase64,
      mime_type: mimeType,
      case_code: caseCode,
      clinical_context: clinicalContext,
    });
  }

  async screenImage(
    imageBase64: string,
    mimeType: string,
    references: ScreenReference[] = [],
  ): Promise<ImageScreenResponse> {
    return this.post<ImageScreenResponse>('/image/screen', {
      image_base64: imageBase64,
      mime_type: mimeType,
      references,
    });
  }

  async iiaCheck(): Promise<IiaCheckResponse> {
    return this.get<IiaCheckResponse>('/audit/iia-check');
  }

  async modelEval(datasetVersion: string, split: string): Promise<ModelEvalResponse> {
    return this.post<ModelEvalResponse>('/model/eval', {
      dataset_version: datasetVersion,
      split,
    });
  }

  /** Delegates the SciPy contrast to Python, where the mandated stack puts it. */
  async pairedTest(payload: PairedTestRequest): Promise<PairedTestResponse> {
    return this.post<PairedTestResponse>('/stats/paired-test', payload);
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    try {
      const result = await this.get<{ status: string; model_backend: string }>('/health');
      return { ok: result.status === 'ok', detail: `motor de IA (${result.model_backend})` };
    } catch (error: unknown) {
      return { ok: false, detail: `motor de IA inaccesible: ${this.describe(error)}` };
    }
  }

  private async get<T>(path: string): Promise<T> {
    return this.request<T>(path, { method: 'GET' });
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const url = `${this.config.aiEngine.url}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.aiEngine.timeoutMs);

    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      if (!response.ok) {
        const detail = await response.text();
        throw new ServiceUnavailableException(
          `El motor de IA respondió ${response.status} en ${path}: ${detail.slice(0, 500)}`,
        );
      }
      return (await response.json()) as T;
    } catch (error: unknown) {
      if (error instanceof ServiceUnavailableException) throw error;
      this.logger.error(`Fallo al llamar al motor de IA en ${url}: ${this.describe(error)}`);
      throw new ServiceUnavailableException(
        `No se pudo contactar al motor de IA en ${this.config.aiEngine.url}. ` +
          'Verifique que acne-ai-engine esté levantado.',
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
