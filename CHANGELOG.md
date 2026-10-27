# Changelog — acne-api

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/);
versionado con [SemVer](https://semver.org/lang/es/).

## [No publicado]

### Added — el caso no se analiza si ninguna foto muestra acné (27/10/2026)

> Migración `LecturaAcneImagen1759000000000`: columna `imagenes_caso.lectura_acne`.

- Al subir se guarda lo que la segunda opinión vio en la foto (`acne_check` del motor); la respuesta
  de subida avisa cuando una toma no muestra acné y el DTO de imagen expone `acneCheck`.
- `POST /inference/...` responde 400 si todas las tomas obligatorias tienen lectura y ninguna es
  `acne` (`lacksAcneEvidence`). Una toma sin lectura no bloquea.
- Mensajes de rechazo para `otra_condicion` (nombra la condición) y `acne_sin_verificar`.

> **Tras actualizar, ejecute `pnpm migration:run`**: añade `InstruccionVistaGeneral1758700000000`,
> `AnulacionCasos1758800000000` y `EstadoDiagnosticados1758900000000`.

### Added — ficha del Anexo 4 (OE1) en Excel (26/10/2026)

- `GET /stats/dataset-export?dataset=tiempos&format=xlsx` entrega la ficha de registro del tiempo de
  revisión como `.xlsx` (`stats/anexo4-workbook.ts`, dependencia `exceljs`): N.º, fecha, código de
  caso, hora de apertura (t₀), hora de firma (t₁), TR (min), fuente, ID de cronometraje y
  observación, con t₀ y t₁ en hora de Lima. Encabezado del instrumento, datos del registro, resumen
  (n, válidos, TRM, DE, mínimo, máximo), nota y firmas; blanco y negro, A4 horizontal. Respeta
  `mode` e `includeSynthetic`; `format=xlsx` con otro dataset responde 400. El CSV no cambia.
- La ficha incluye la columna **Paciente** (código PAC), «Datos incluidos» refleja si la ficha trae
  sintéticos (no el estado de la casilla), y la fuente y la nota salen de `origen_codigo`: las filas
  `importada`/`transcrita` se declaran como cronometraje manual, no como sellado por el servidor.
- `importar-tiempos.ts` marca `origen_codigo = 'importada'` en las filas que reemplaza.
- El TR de la ficha sale de t₁ − t₀ y no de `duracion_segundos` (entero): 12 de los 31 casos del
  19/10 se leían una centésima distinta de la ficha en papel (5,64 → 5,63). Nueva columna
  «TR (min:s)» para que la resta de horas se pueda comprobar a la vista.

### Fixed — un caso diagnosticado ya no vuelve a «En revisión» (25/10/2026)

- `POST /cases/:id/open` escribía `en_revision` sin mirar el estado, y el portal vuelve a abrir la
  ficha después de firmar el diagnóstico: todos los casos diagnosticados (31 de 31) se veían «En
  revisión». Ahora solo un `borrador` pasa a revisión al abrirse. La migración
  `EstadoDiagnosticados1758900000000` devuelve a `diagnosticado` los casos con diagnóstico del
  sistema (postest) que habían quedado mal.

### Changed — tres etapas visibles: Borrador, En revisión, Revisado (25/10/2026)

- `CASE_STAGES` / `CASE_STAGE_OF` (`common/domain/study.ts`) agrupan los siete estados internos:
  `procesado_ia` y `solicitar_fotos` se ven «En revisión»; `diagnosticado`, `derivar_presencial` y
  `cerrado`, «Revisado». Los estados internos no cambian (transiciones, anexos, auditoría).
- Los resúmenes traen `stage`; `GET /cases?stage=` filtra por etapa; `GET /meta/catalogs` sirve
  `caseStages {values, labels, ofStatus}`.

### Added — editar, eliminar o anular un caso, para los tres roles (25/10/2026)

- **`POST /cases/:id/remove`** `{reason}` (mínimo 10 caracteres), para admin, dermatólogo y técnico.
  Si el caso aún no tiene **evidencia del estudio** (diagnóstico, cronometraje de revisión, inferencia
  o receta) se **borra** con sus fotos (también los bytes cifrados del almacenamiento), su anamnesis
  y sus sesiones de captura. Si ya la tiene se **anula**: columnas `anulado_en`, `anulado_por` y
  `motivo_anulacion` en `casos`; corta los QR vivos y descuenta el caso de la jornada en la que contó
  para TCAD. Es un `POST` y no un `DELETE` por la regla de `no-hard-delete.spec.ts`: lo que tiene
  evidencia recibe una lápida, como `POST /patients/:id/withdraw`. Auditoría: `case.delete` o
  `case.void`, con el motivo y la evidencia. Regla en `common/domain/case-removal.ts`.
- **Un caso anulado sale de todo lo que mide el estudio**: bandeja (`GET /cases`), indicadores
  (TRM, TPD, pares de los contrastes), Anexos 4 y 5, las seis exportaciones, el historial y el
  resumen por paciente, y el precargado de anamnesis de visitas anteriores. Y **no admite cambios**:
  `assertCaseActive` (`src/cases/case-guards.ts`) lo rechaza al subir o reetiquetar fotos, guardar
  la anamnesis, pedir el análisis, diagnosticar, recetar o emitir un QR; `findActiveEntity` al
  abrir, cerrar, devolver, reenviar o derivar.
- **`PATCH /cases/:id` para los tres roles**: paciente (`patientId`; se rechaza si el caso ya tiene
  diagnóstico o receta, o si el paciente retiró su consentimiento), profesional asignado (cuenta
  activa) y notas. El patrón de consenso sigue reservado a quien diagnostica y al administrador (403).
- `GET /cases/assignees`: cuentas activas a las que se puede asignar un caso.
- `GET /cases/:id` trae `removal {mode: eliminar|anular, evidence[]}`; los resúmenes, `notes`,
  `voidedAt` y `voidReason`.
- Se añadió la etiqueta de auditoría de `diagnosis.correct`, que faltaba (fallaba `audit.spec.ts`).

> **Tras actualizar, ejecute `pnpm migration:run`**: esta tanda añade dos migraciones
> (`SegundaOpinion1758400000000` y `OrigenVeredicto1758500000000`) y la API no las aplica sola fuera
> de Docker (`RUN_MIGRATIONS=true`).

### Added — segunda opinión y origen del veredicto (22/10/2026)

- **Persistencia de la segunda opinión del motor** (verificación previa con Gemini, consultada solo
  para las tomas que el filtro deja pasar como acné). Migración `SegundaOpinion1758400000000` en
  `inferencias_ia`: `segunda_opinion_codigo` varchar(16) NULL con CHECK (`acne` | `piel_sana` |
  `otra_condicion` | `indeterminado`), `segunda_opinion_condiciones` varchar(300) (nombres unidos por
  «; »: texto para mostrar, nunca se agrega), `segunda_opinion_explicacion` varchar(400) y
  `segunda_opinion_version` varchar(120).
- **Origen del veredicto.** Migración `OrigenVeredicto1758500000000`: `veredicto_origen`
  varchar(16) NOT NULL DEFAULT `'filtro'` con CHECK (`filtro` | `segunda_opinion`). Vale
  `segunda_opinion` cuando la verificación previa vio otra condición y la toma no se graduó aunque el
  filtro dijera acné.
- `src/inference/second-opinion.ts` (`toSecondOpinionColumns`, `fromSecondOpinionColumns`): mapeo
  entre la respuesta del motor, las cuatro columnas y el DTO (recorta a la longitud de cada columna).
  `second-opinion.spec.ts`.
- DTO: `AiInferenceDto.secondOpinion` (`SecondOpinionDto`: `label`, `conditions`, `explanation`,
  `version`; nula si no se consultó) y `AiInferenceDto.verdictSource`.
- `ai-engine.client.ts` y `ai-engine.schema.d.ts` (tipos regenerados del OpenAPI del motor):
  `second_opinion`, `verdict_source`. Un motor anterior sin esos campos se lee como `filtro` y sin
  segunda opinión.

### Changed — agregación de las tomas en la sugerencia del caso (22/10/2026)

- **`viewsForSuggestion`** (`common/domain/case-analysis.ts`): si alguna toma muestra acné, las
  tomas de piel sana se **descartan** de la sugerencia. Su «confianza» es la probabilidad del filtro,
  no un grado IGA, y ganaban siempre (una mejilla limpia al «100 %» vencía a una severa al 69 % y el
  caso salía `sin_lesiones`). Solo si ninguna toma muestra acné, las sanas sostienen la sugerencia
  (`piel_sana`). La regla de mayoría (y, si todas difieren, la toma más segura) no cambia.
- `CaseAnalysisDto.healthyViewsSetAside`: `imageId` de las tomas sanas descartadas (el portal marca
  su fila «Descartada»).
- `CaseAnalysisDto.noAcneViews` incluye las tomas detenidas por el filtro **o** por la segunda
  opinión (`verdictSource`).
- Pruebas: `case-analysis.spec.ts` cubre el descarte. Total: **198** pruebas (jest).

### Added — veredicto del filtro de acné (13/10–19/10/2026)

- Migraciones `VeredictoAcne1758200000000` y `VeredictoPielSana1758300000000`:
  `inferencias_ia.veredicto_codigo` (`acne` | `piel_sana` | `no_acne`), `probabilidad_acne` y
  `version_filtro`. Una toma `no_acne` se guarda exitosa sin clase, GAGS ni Grad-CAM y no se
  reintenta; `piel_sana` se guarda como lectura `sin_lesiones` con la probabilidad del filtro.
- `caseVerdictOf` (`common/domain/case-analysis.ts`): veredicto del caso; las tomas `no_acne`
  quedan fuera de la sugerencia y se informan en `CaseAnalysisDto.noAcneViews`.
- `diagnoses.service.ts`: la aceptación de la sugerencia se compara con la clase del caso.

### Added — validación de la vista de cada toma (01/10/2026)

- `common/domain/shot-view.ts` (`checkShotView`), aplicada al subir y al cambiar la toma de una
  foto. Rechaza (422): la misma fotografía en dos tomas, una «Vista general» girada, un perfil de
  frente y los dos perfiles girados hacia el mismo lado. Advierte: perfil que parece del otro lado
  (posible selfie espejada) y orientación indeterminada.
- Migración `OrientacionDeTomas1758100000000`: `imagenes_caso.orientacion_detectada`, tomada del
  cribado del motor.

### Added — traslado del almacenamiento local a MinIO (24/09/2026)

- **`pnpm storage:to-minio`** (`src/scripts/migrate-storage-to-minio.ts`): copia cada archivo de
  `STORAGE_LOCAL_PATH` al bucket con la **misma clave**. La API lee por clave en el almacenamiento
  activo, así que no hay que tocar `clave_almacen` ni `firma_ruta`. Los bytes viajan tal cual
  (ciphertext AES-256-GCM). Es idempotente: omite lo que ya está con el mismo tamaño, verifica cada
  objeto tras subirlo y nunca borra los archivos locales. `--dry-run` lista lo que subiría;
  `--update-db` marca `imagenes_caso.driver_almacen = 'minio'`.
- `.env.example` documenta `STORAGE_DRIVER=minio` y las variables `MINIO_*`.

### Fixed — PDF en Docker y migraciones al arrancar (23/09/2026)

- La etapa de ejecución del `Dockerfile` deja la imagen fija `playwright:v1.48.2` e instala Chromium
  con `pnpm exec playwright install --with-deps chromium`. Así el navegador coincide siempre con la
  versión de `playwright` del lockfile (1.62.1); con la imagen fija, los PDF fallaban.
- `RUN_MIGRATIONS=true` aplica `dist/database/run-migrations.js` antes de servir.

### Added — la receta como PDF, descargable y adjunta al WhatsApp (21/09/2026)

- **`PrescriptionPdfService`** (`src/prescriptions/prescription-pdf.service.ts`): receta A4 con
  membrete de la clínica (`CLINIC_*`), paciente (nombre, documento, código, edad, sexo),
  diagnóstico del caso (texto definitivo, CIE-10 con su nombre, IGA, GAGS), tabla de medicamentos
  con indicación por ítem, indicaciones generales, observaciones para el paciente, rúbrica
  registrada del médico (`usuarios.firma_ruta`), especialidad, código de verificación (SHA-256) y
  pie con la advertencia legal. Chromium de Playwright, bajo demanda.
- **`GET /prescriptions/:id/pdf`** (descarga autenticada, auditada como `prescription.download`)
  y **`GET /prescriptions/:id/document?token=`** (pública, con token firmado de 15 min ligado a la
  receta y a quien envía; auditada como `prescription.fetch`): de aquí recoge Infobip el PDF.
- `send` por WhatsApp intenta primero **documento** (`/whatsapp/1/message/document`, `mediaUrl`
  = `PUBLIC_BASE_URL` + ruta pública) y solo después texto y plantilla; `detalle` cuenta las rutas
  probadas. `PUBLIC_BASE_URL` (p. ej. el túnel de ngrok) vacío = la receta viaja como texto.
- Probado de punta a punta el 21/09/2026: Infobip recogió el PDF por el túnel y lo entregó al
  número verificado.

### Added — WhatsApp real por Infobip (21/09/2026)

- **`src/messaging/`**: `InfobipWhatsAppClient` (`POST /whatsapp/1/message/text` y
  `…/template`, `Authorization: App`, números normalizados a internacional con
  `MESSAGING_DEFAULT_COUNTRY_CODE=51`, tiempo de espera, sin reintentos) y `WhatsAppService`, que
  envía la receta como texto formateado y, si Meta lo rechaza por no haber sesión de 24 h, recurre a
  la plantilla (`INFOBIP_WHATSAPP_TEMPLATE`, por defecto la de prueba de Infobip). Variables
  `INFOBIP_BASE_URL`, `INFOBIP_API_KEY`, `INFOBIP_WHATSAPP_SENDER`, `INFOBIP_WHATSAPP_TEMPLATE[_LANGUAGE]`.
- `PrescriptionsService.send` deja de simular WhatsApp cuando hay credenciales: la fila de
  `envios_receta` guarda `exitoso` y `detalle` reales (ruta usada, `messageId`, motivo de rechazo) y
  un envío rechazado no pasa la receta a «enviada». `GET /meta/catalogs` calcula
  `deliveryChannels.simulated` con la configuración vigente, así el portal deja de marcar
  «simulado» solo. `src/messaging/whatsapp.spec.ts` (9 pruebas con `fetch` simulado).

- **`PUT /inference/case/:caseId/selection`** `{ inferenceId, memberTag?, reason? }` y
  **`POST /inference/case/:caseId/selection/withdraw`**: el técnico o el dermatólogo fija una
  celda de la matriz (una toma y, opcionalmente, un modelo) como sugerencia del caso. Migración
  `1758000000000-LecturaElegida` (`lecturas_elegidas`: historial, `retirada_en` en vez de borrado,
  índice único parcial «una activa por caso»). `CaseAnalysisDto.selection`
  (`CaseReadingSelectionDto`, con `active`) y `rule = 'seleccion_manual'`; la clase, la confianza,
  el vector, `decidedBy`, `ruleDescription` («Lectura elegida por … : Perfil derecho
  (efficientnet_b2) → moderado. Motivo: …») y la lectura del caso siguen la elección, y con ellas
  la comprobación anamnesis↔imagen y la ficha de diagnóstico. Rechaza (400) una inferencia que no
  sea la vigente de su imagen, no terminada o un modelo que no leyó esa toma. Auditoría
  `analysis.select` / `analysis.unselect`. Los indicadores de OE2 no la leen.

### Added — volver a analizar (18/09/2026)

- `POST /inference/case/:caseId?force=true` encola una lectura nueva de cada toma obligatoria
  aunque ya exista una con éxito (`InferenceService.request(…, force)`): la vía para releer un caso
  cuando cambió el modelo servido. Las inferencias anteriores se conservan; el análisis del caso
  toma la más reciente de cada imagen. Los textos de `AiInferenceDto.members` y
  `CaseAnalysisDto.igaClass` describen la regla vigente del motor (miembro más seguro) y la del caso.

### Changed — regla de la sugerencia del caso (18/09/2026)

- `common/domain/case-analysis.ts::aggregateViews` sustituye al promedio de vectores: **mayoría de
  tomas** (clase de las tomas que coinciden, con su confianza media) y, si las tres difieren, **la
  toma en la que el ensemble estuvo más seguro**. El promedio en una escala ordinal producía clases
  que ninguna toma había visto (leve + severo + casi sin lesiones → «moderado 29 %»).
  `CaseAnalysisDto` añade `rule`, `ruleDescription`, `decidedBy` y `range`; la lectura del caso
  explica la regla y el rango entre tomas.

### Added — lectura estructurada del caso (17/09/2026)

- **`CaseAnalysisDto.reading`** (`common/domain/reading.ts::buildCaseReading`): la lectura clínica
  que acompañaba a la sugerencia con Gemini y que la CNN no produce, escrita por el sistema a partir
  de lo que sí sabe con certeza — grado por toma, votos discordantes de cada modelo, acuerdo,
  asimetría entre perfiles, definición clínica de cada grado IGA (FDA), lo que aporta la anamnesis
  (embarazo, medicación, alergias, evolución, tronco, signos hormonales…), diferenciales que la
  historia sugiere y aspectos de manejo que las guías piden valorar. Nunca inventa hallazgos
  (`lesionTypes` queda vacío: el modelo no cuenta ni tipifica lesiones) ni prescribe (RNF-06). Misma
  forma que `AiAssessmentDto`, así que el portal la muestra con el mismo componente.

### Added — análisis del caso completo, multi-vista (17/09/2026)

- **`POST /inference/case/:caseId`** encola una inferencia por toma obligatoria (vista general y
  ambos perfiles, última fotografía de cada una); idempotente por imagen. **`GET
  /inference/case/:caseId/analysis`** y `CaseDetailDto.caseAnalysis` devuelven la lectura de cada
  toma (con sus miembros y Grad-CAM) y la **sugerencia del caso**: promedio de los vectores de
  probabilidad de las tomas obligatorias, con acuerdo entre tomas. IGA gradúa la cara completa;
  analizar solo la última foto subida graduaba una mejilla. Se calcula en lectura, no se persiste.
  La incongruencia anamnesis ↔ imagen y el bloqueo del diagnóstico usan la clase del caso.

### Changed — la incongruencia anamnesis ↔ imagen bloquea el diagnóstico (17/09/2026)

- `DiagnosesService.submit` rechaza con **400** el diagnóstico mientras `anamnesisImageMismatch`
  encuentre contradicción entre la sugerencia de la IA y el cuestionario, salvo que el especialista
  envíe `mismatchAcknowledged: true` y un `mismatchReason` (≥ 10 caracteres), que quedan en la
  auditoría de `diagnosis.submit` (RNF-05). La decisión sigue siendo del médico (RNF-06); lo que ya
  no es posible es firmar sin haberla visto. Al técnico solo se le avisa en el ingreso.

### Added — corregir la toma de una fotografía (17/09/2026)

- **`POST /images/:id/shot { shotKey }`** (`INTAKE_ROLES`, auditado como `image.relabel`). Tres
  fotografías subidas como «Vista general» son, en la práctica, una general y dos perfiles mal
  rotulados, y hasta ahora la única salida era borrarlas y volver a subirlas. Reetiquetar no toca
  los bytes ni afecta a inferencias o diagnósticos; solo la comprobación de tomas obligatorias lee
  la etiqueta. Un mapa de calor no se reetiqueta (400).

### Added — ensemble de modelos (17/09/2026)

- **`miembros_inferencia`** (migración `1757900000000`): la lectura de cada modelo dentro de una
  inferencia de ensemble — clase, confianza, vector (`jsonb`), Grad-CAM propio (`imagen_mapa_calor`),
  versión, checksum, peso y latencia — y `inferencias_ia.acuerdo_codigo`
  (`unanime|mayoria|discrepancia`). `version_modelo` pasa a 200 caracteres. `InferenceService.execute`
  guarda un mapa de calor por miembro con `storeHeatmap`; `AiInferenceDto.members[]` y `agreement`.
  La cabecera sigue siendo la única clase que mide OE2.

### Added — validaciones del caso antes de evaluarlo (17/09/2026)

- **Protocolo fotográfico mínimo.** Las tomas obligatorias pasan a ser `general`, `perfil_derecho`
  y `perfil_izquierdo` (`common/domain/capture.ts` + migración `1757800000000`); `acercamiento` y
  `borde` quedan opcionales. `missingRequiredShots()` / `describeMissingShots()` en el dominio,
  `ImagesService.missingRequiredShots(caseId)` en servicio, y **400** en
  `InferenceService.request`, `DiagnosesService.submit` y `CasesService.resubmit` mientras falte
  alguna. `POST /cases/:id/open` no se toca: el especialista puede revisar el caso y devolverlo con
  «Solicitar fotos». `CaseDetailDto.missingShots` lo expone, igual para todos los roles.
- **`POST /images/case/:caseId` acepta `shotKey`.** El portal ya lo enviaba y la API lo ignoraba,
  de modo que toda fotografía subida desde el escritorio quedaba sin toma y no contaba para nada.
  Un valor desconocido responde 400; ausente sigue siendo «sin protocolo».
- **Aviso de incongruencia anamnesis ↔ imagen.** `reportsActiveAcne()` (heurística sobre
  `tiempo_evolucion`, `sintomas`, `zona_extrafacial`, `empeora_premenstrual`; el instrumento no
  tiene pregunta directa) y `anamnesisImageMismatch()` (`common/domain/incongruence.ts`): si la
  inferencia exitosa dice `sin_lesiones` o `casi_sin_lesiones` y la historia describe lesiones
  activas, `CaseDetailDto.anamnesisMismatch` lleva los mensajes. Se deriva en lectura, no se
  persiste, y vive dentro del bloque `aiVisible`. Informativo (RNF-06).
- `AnamnesisService.answersForCase(caseId)` — respuestas crudas o `{}` si no hay cuestionario.
- Specs: `capture.spec.ts`, `incongruence.spec.ts`, y `reportsActiveAcne` en `anamnesis.spec.ts`.

### Added — el alta de personal, por rol

- **Permiso `gestionar_tecnicos`**, para `dermatologo` y `admin`. En una clínica pequeña quien
  decide que hace falta otra persona en admisión es el médico: obligarle a pedir la cuenta al
  administrador es el trámite que en la práctica se salta compartiendo credenciales, y una
  credencial compartida rompe la trazabilidad de la que vive RNF-02 — el asiento diría quién
  tecleó, no quién estaba.
- **El alcance lo pone el servidor, no la pantalla.** `manageableRoles(rol)` decide qué roles ve y
  crea cada quien: con `gestionar_usuarios`, todos; solo con `gestionar_tecnicos`, únicamente
  `tecnico`. `GET /users` INTERSECA lo pedido con ese alcance —se acota, no se niega— y `POST
  /users` y `POST /users/:id/password-reset` responden 403 diciendo qué se intentó. Un desplegable
  con una sola opción no impide un `curl`, y hay pruebas de que no lo impide.
- **`usuarios.telefono_cifrado`**: teléfono de contacto del personal, AES-256-GCM antes de tocar la
  fila, igual que el del paciente. El número de quien atiende identifica a una persona exactamente
  igual que el de quien es atendido (Ley N.º 29733).

### Fixed — la especialidad no se podía escribir

- **`CreateUserDto` tenía los decoradores de `studyMode` sin su propiedad.** Un decorador suelto se
  aplica a la SIGUIENTE propiedad declarada, así que `specialty` había heredado un
  `@IsIn(STUDY_MODES)`: crear un dermatólogo con su especialidad escrita devolvía 400, y el mensaje
  hablaba de modos de estudio. Residuo de retirar el modo de estudio del usuario.


### Added — quitar una fotografía y analizar el caso

- **`POST /images/:id/remove`** retira una fotografía subida por error, con sus bytes. Se borra de
  verdad y no se marca: una imagen clínica que nadie llegó a leer es un dato personal que ya no
  hace falta, y guardarla «por si acaso» es justo lo que la Ley N.º 29733 pide no hacer. Queda el
  asiento de auditoría (`image.remove`), que dice quién la quitó y cuándo (RNF-05).
- **Se niega en dos casos**, y ninguno es burocracia: si el modelo ya leyó la imagen —la inferencia
  y su mapa de calor son una lectura DE esa fotografía— o si el especialista ya firmó un
  diagnóstico, porque entonces la fotografía es la evidencia sobre la que firmó. En ambos la salida
  real es subir la correcta: el caso admite varias.
- POST y no DELETE, como el resto de la API: `no-hard-delete.spec.ts` prohíbe `@Delete` en todo el
  proyecto.
- **`GET /patients/:id/history` devuelve ahora la lectura razonada de cada visita.**
  `HistoryInferenceDto.assessment` trae el resumen, el fundamento de la severidad, las lesiones,
  las zonas, los diferenciales, las consideraciones y las banderas de la anamnesis. Se guardaban
  desde el principio en `valoraciones_inferencia` y `detalles_valoracion`, y no se mostraban en
  ningún sitio salvo la ficha del caso abierto: a seis meses vista, una clase IGA suelta no se
  puede contrastar con nada.

### Fixed — el análisis podía quedarse «en curso» para siempre

Encontrado al probar el botón nuevo contra la base remota, que se vuelve inalcanzable a ratos
(`ENETUNREACH`, `ECONNRESET`). Tres agujeros encadenados, cada uno inofensivo por separado:

- **Un trabajo reclamado no volvía nunca a la cola.** `claimNext` solo miraba los `pendiente`, de
  modo que un trabajo marcado `ejecutando` cuyo obrero murió a medias se quedaba ahí para siempre.
  La columna `bloqueado_en` se escribía y no la leía nadie; ahora es un ARRIENDO
  (`QUEUE_LEASE_MS`, por defecto cuatro veces el tiempo del motor) y, vencido, otro obrero lo
  reclama. El comentario del fichero prometía justo esto y no era cierto.
- **`expireStale()`** cierra los trabajos abandonados que ya agotaron sus intentos y marca fallidas
  sus inferencias con un mensaje que se entiende. Una inferencia eternamente `pendiente` es peor
  que una fallida: la segunda se reintenta desde la pantalla, la primera solo parece una cola lenta.
- **El guardia `draining` podía quedarse puesto.** Si un turno no terminaba —una consulta contra un
  socket medio abierto no vuelve nunca—, la cola entera moría en silencio hasta reiniciar la API,
  con la pantalla diciendo «el modelo está leyendo el caso». Ahora el turno tiene plazo y el
  guardia siempre se suelta.
- **Ninguna consulta espera indefinidamente**: `statement_timeout` y `query_timeout`
  (`DB_STATEMENT_TIMEOUT_MS`, 60 s), plazo de conexión (`DB_CONNECT_TIMEOUT_MS`, 15 s) y `keepAlive`,
  para que un enlace caído se note en segundos y no cuando el sistema operativo se rinda.

### Fixed — las preguntas creadas desde el portal no llegaban al modelo

- **`buildClinicalContext` recorría `ANAMNESIS_QUESTIONS`**, la constante semilla, y descartaba
  toda clave que no estuviera en ella. Desde que el cuestionario es administrable, una pregunta
  creada desde el portal se respondía, se archivaba… y se caía en silencio camino del modelo. El
  catálogo pasa a ser un PARÁMETRO explícito, y `InferenceService` le pasa
  `QuestionsService.catalogue()` — la tabla, que es quien manda.
- **`POST /images/case/:caseId` estaba limitada al grupo que diagnostica**, de modo que el técnico
  recibía 403 al subir una fotografía desde la misma pantalla que el portal le ofrece. La toma
  fotográfica es parte del ingreso: ahora la ruta es de `INTAKE_ROLES`.


### Fixed

- **`GET /patients/:id/history` no devolvía el `status` de cada visita**, pese a declararlo en el
  DTO: el SELECT pedía `c."estado_codigo"` sin alias, de modo que la fila cruda traía esa clave y el
  mapeo leía `row.status`, que era `undefined`. Otro residuo del renombrado al español, invisible
  para el compilador por ser una cadena SQL. Se notó al pintar la línea de tiempo de la ficha, que
  mostraba un «·» colgando sin etiqueta.

### Fixed — la firma no se veía

- **`GET /signatures/me/image` estaba protegida por `@Roles`**, y una etiqueta `<img>` no puede
  adjuntar la cabecera Authorization: el navegador recibía 401 y pintaba una imagen rota. Ahora se
  sirve como las fotografías clínicas —ruta `@Public()` autorizada por una URL firmada de vida
  corta, atada al profesional— y el DTO devuelve esa URL ya construida.
- **El `Content-Type` se deduce de los bytes.** Se declaraba siempre `image/png`, de modo que una
  rúbrica en JPEG habría llegado con el tipo equivocado y algunos navegadores se habrían negado a
  pintarla.
- La URL lleva la marca de tiempo de la última actualización, para que reemplazar la firma no
  siga mostrando la anterior desde la caché del navegador.

### Changed — el cuestionario de ingreso se administra por completo (BREAKING)

- **La base de datos pasa a ser la fuente de verdad del cuestionario.**
  `common/domain/anamnesis.ts` queda como la SEMILLA con que arranca una instalación nueva, y
  `preguntas_anamnesis` decide qué se pregunta hoy. `anamnesis.service` valida contra la tabla, de
  modo que una pregunta creada desde el portal se puede responder de inmediato — contra la
  constante habría sido «una pregunta que no existe».
- `CatalogConsistencyService` deja de comparar esa tabla con la constante: exigir que coincidan
  impediría exactamente lo que la pantalla ahora permite.
- **`POST /questions`** crea, **`PATCH /questions/:id`** edita y **`POST /questions/:id/remove`**
  elimina. La clave se normaliza a minúsculas sin tildes ni espacios y es única.
- **Dos reglas protegen lo ya respondido**, y no son burocracia: una pregunta con respuestas no
  cambia de clave, tipo, ámbito ni opciones —los valores guardados se interpretan según ellos— ni
  se elimina. La redacción se corrige siempre y desactivarla la retira del ingreso sin tocar el
  historial. El DTO expone `answerCount` y `locked` para que la pantalla lo muestre antes de que
  alguien lo intente.

### Fixed

- **Las nueve preguntas de elección se habrían quedado sin opciones.** `preguntas_anamnesis` se
  sembró antes de que existiera la columna `opciones`, así que las listas cerradas vivían solo en la
  constante; al pasar la tabla a fuente de verdad, el ingreso las habría pintado como controles
  vacíos y el validador habría rechazado cualquier respuesta. Migración de relleno con los valores
  EXACTOS de la constante, más un CHECK que impide dejar una pregunta de elección sin opciones.

### Fixed — buscar sin que la tilde decida

- **Teclear «isotretinoina» no encontraba ISOTRETINOÍNA, ni «Chavez» a Chávez.** La comparación era
  literal en los cuatro buscadores del sistema, y en un registro lleno de apellidos peruanos con
  tilde eso convierte la búsqueda en una adivinanza: el usuario concluye que el dato no existe.
- **Dos rutas, una sola regla.** Las búsquedas que van por SQL —medicamentos y usuarios— usan la
  extensión `unaccent` de PostgreSQL; las de pacientes y casos comparan en memoria porque el nombre
  está cifrado y solo existe descifrado (RF-TR-03), y usan el nuevo `normalizeForSearch`.
- **La normalización va en los DOS lados**, término y texto guardado. Limpiar solo el término
  dejaría el problema simétrico: quien sí escribe la tilde no encontraría lo guardado sin ella.
- La `ñ` se reduce a `n` en ambas rutas. No es una preferencia: es lo que hace `unaccent`, y dos
  reglas distintas harían que «munoz» encuentre al paciente en una pantalla y no en la otra.

### Added — almacén, preguntas y firma

- **Almacén.** El vademécum llega poblado con los **25 fármacos y 51 indicaciones** que la clínica
  ya usa en DermAsist, extraídos de su lista de medicamentos. CRUD completo bajo
  `gestionar_medicamentos`; `GET /prescriptions/medications/all` muestra también los retirados, que
  es lo que permite reactivarlos, mientras el buscador de la receta sigue ofreciendo solo activos.
- **Preguntas.** `preguntas_anamnesis` existía desde la normalización y **nadie la leía**: el
  catálogo servía el texto desde la constante de TypeScript, de modo que editar la tabla no cambiaba
  nada. Ahora `GET /meta/catalogs` lee de la tabla. El reparto es deliberado — la CLAVE, el TIPO,
  el ÁMBITO y las OPCIONES siguen en el dominio porque son el contrato que valida las respuestas ya
  guardadas; solo la REDACCIÓN es editable.
- **Firma.** El especialista sube su rúbrica una vez y se guarda cifrada como cualquier imagen
  clínica. NO es una firma electrónica reconocida: lo que detecta una receta alterada es el SHA-256
  de `recetas`, y así lo dice la pantalla.

### Fixed

- **`PATCH /questions/:id` devolvía 400 a peticiones válidas.** El DTO se importaba con
  `import type`, que borra la clase al compilar: sin ella el `ValidationPipe` no encuentra ninguna
  propiedad permitida y rechaza la petición entera con «property text should not exist». Typecheck
  y lint pasaban; solo fallaba al llamarla. Nuevo tripwire `body-dto-runtime.spec.ts` que recorre
  los controladores y falla si un DTO usado en `@Body()` se importa como tipo.
- `DELETE /signatures/me` pasa a `POST /signatures/me/remove`: el tripwire de «no borrar» lo atrapó,
  y la convención del proyecto es POST más lápida, como `POST /patients/:id/withdraw`.

### Changed — la jornada es de los dos puestos

- **El técnico abre y cierra jornada.** Su NCR cuenta pacientes ADMITIDOS y el del especialista
  cuenta diagnósticos FIRMADOS: `countReviewedCase` pasa a llamarse `countCompletedCase` y suma en
  el alta del caso para quien no diagnostica, en la firma para quien sí. Contar ambas cosas al
  dermatólogo le habría duplicado cada caso y sacado un TCAD al doble.
- **`pairedTcad` filtra por rol.** Sin eso una jornada de mostrador —con NCR de admisiones— entraba
  en HE₄ junto a las de diagnóstico y hundía la media: OE4 mide capacidad de atención DIAGNÓSTICA,
  y promediar las dos cifras compararía peras con manzanas. Verificado en vivo: tras cerrar una
  jornada del técnico, HE₄ se queda en n=16 y la media postest no se mueve.

### Changed — el pretest sale del sistema (BREAKING)

- **El modo de estudio deja de ser un interruptor por usuario.** Antes el mismo dermatólogo revisaba
  los treinta casos «en pretest», con la IA bloqueada por el servidor, y los volvía a revisar «en
  postest»: eso medía el sistema contra sí mismo con una mano atada y le pedía al especialista
  fingir que no sabía lo que ya había visto.
- **El pretest es ahora la evaluación MANUAL de la clínica**, la que se hace sin software. Toda
  medición registrada por el sistema es `postest` por construcción (`SYSTEM_MEASUREMENT_MODE`), y
  las de pretest entran transcritas por el administrador.
- Se eliminan `usuarios.modo_estudio_codigo`, el modo `produccion`, `StudyModeGuard`,
  `@RequiresAiEnabled()` y `PATCH /users/me/study-mode`. La IA está siempre disponible para quien
  puede verla.
- **Nueva tabla `origenes_medicion`** (`sistema` · `transcrita` · `importada`) sobre
  `cronometrajes_revision`, `diagnosticos` y `jornadas_trabajo`. Sin ella un evaluador no puede
  distinguir un cronometraje medido de uno tecleado, y la diferencia es la que separa la evidencia
  del testimonio. `cargas_linea_base` registra cada importación con cuántas filas traía y cuántas
  se aplicaron.

### Changed — quién lee la evidencia

- **Indicadores, contrastes, anexos, reportes y el resumen de la encuesta pasan a ser exclusivos del
  administrador.** El profesional es el SUJETO de la medición: darle sus propias cifras mientras las
  produce invita a que el número influya en el trabajo que ese mismo número está midiendo. Las rutas
  se ataron a `ANALYSIS_ROLES` en vez de `STUDY_ROLES`, que seguía incluyendo al dermatólogo por
  tener `diagnosticar`.
- **El técnico responde la encuesta de satisfacción.** Opera el sistema tanto como el especialista
  —registra, fotografía, entrega la receta— de modo que su satisfacción es parte de lo que mide OE3;
  excluirlo dejaba fuera a la mitad de quienes lo usan.

### Added — contacto del paciente

- **`pacientes.telefono_cifrado` y `pacientes.correo_cifrado`**, cifrados con AES-256-GCM como el
  nombre y el documento. La entidad ya los mapeaba y la migración nunca los creaba: el typecheck no
  puede ver eso, y `POST /prescriptions/:id/send` sin destino explícito moría contra una columna
  inexistente. Se piden en el ingreso y se pueden corregir después.
- `GET /patients/:id/identity` devuelve ahora también teléfono y correo, con la misma restricción de
  rol que el resto de la identidad.

### Fixed

- **Enviar una receta por correo usaba el teléfono.** El respaldo de destino tomaba siempre
  `telefono_cifrado`, sin mirar el canal, de modo que el envío se registraba contra un número y
  nadie lo recibía. Ahora WhatsApp toma el teléfono y el correo toma el correo, y el mensaje de
  error nombra el dato que falta.

### Added — el proceso clínico completo, tomado de DermAsist

Hasta aquí el prototipo cubría la MEDICIÓN y se detenía cuando el especialista firmaba una clase
IGA. El paciente se iba sin diagnóstico redactado, sin CIE-10 y sin tratamiento. Esta entrega trae
el proceso que DermAsist ya opera y lo monta sobre el diseño experimental sin romperlo.

- **Diagnóstico redactado + CIE-10** sobre `diagnosticos`, NO sobre `casos`. DermAsist lo guarda en
  el caso porque allí se valida una vez; aquí se valida dos —pretest y postest sobre el mismo caso—
  y ponerlo en `casos` haría que la segunda validación pisara a la primera y destruyera el par que
  OE1 y OE2 contrastan. La clase IGA sigue siendo obligatoria: es lo único comparable con el patrón
  de referencia.
- **Catálogo CIE-10** (13 códigos de acné y sus diferenciales), leído de la base y no de una
  constante: es el único catálogo que un mantenedor puede ampliar sin desplegar.
- **Dos ramas nuevas del caso**: `solicitar_fotos` devuelve el caso al mostrador y
  `derivar_presencial` lo saca del circuito digital. Con sus transiciones y su motivo obligatorio.
- **Vademécum** (`medicamentos` + `indicaciones_medicamento`): la dosis sugerida cuelga de la
  INDICACIÓN y no del fármaco, porque la isotretinoína no se pauta igual en un acné moderado que en
  uno conglobata. Siete fármacos base de acné, cargables con un endpoint idempotente.
- **Recetas** (`recetas` + `items_receta` + `envios_receta`), con firma SHA-256, anulación en vez de
  edición, y envío por WhatsApp/correo/descarga. El `nombre` del renglón se COPIA del catálogo:
  renombrar un fármaco no puede reescribir lo que el paciente ya se llevó impreso.
- **Teléfono del paciente cifrado** (`pacientes.telefono_cifrado`), para poder hacerle llegar la
  receta sin convertir la tabla en un directorio telefónico.
- Tres permisos nuevos —`prescribir`, `enviar_receta`, `gestionar_medicamentos`— y el técnico gana
  `ver_sugerencia_ia`.

### Changed

- **El mostrador ve la sugerencia del modelo.** Replica DermAsist, donde la IA corre al crear el
  caso y quien lo registra ve el resultado. Es una amenaza a la validez interna DECLARADA en
  TRACEABILITY.md: el gate del **dermatólogo** en pretest sigue intacto y cada lectura se audita.
- **TRM no cuenta la espera en el mostrador.** Devolver un caso por fotos INVALIDA la medición en
  curso en vez de detenerla: entre la devolución y la reposición pueden pasar días, y contarlos
  haría de TRM una medida de la logística de la clínica. La fila invalidada se conserva.
- **`derivar_presencial` es final y no es un éxito**: el especialista dedicó ese tiempo (TRM lo
  recoge) pero el caso no produce diagnóstico comparable, así que queda fuera de TPD y de TCAD.

### Fixed

- **Crear un paciente o un caso por la API fallaba.** `nextSequentialCode` recibía los nombres de
  tabla y columna en INGLÉS (`'cases'`, `'case_code'`, `'patients'`, `'patient_code'`) como cadenas,
  que el renombrado a español no podía ver ni el compilador comprobar. Solo se manifestaba al crear
  desde la API: los seeders insertan con SQL directo.

### Changed — el administrador ve el nombre del paciente

- **`admin` gana `ver_identidad_paciente`.** Su bandeja mostraba `PAC-2026-S011` donde las otras dos
  muestran un nombre, y su buscador por nombre no devolvía nada: la búsqueda filtra sobre el nombre
  DESCIFRADO, así que sin el permiso no había nada sobre lo que buscar. Negarle la lectura tampoco
  protegía gran cosa — ya escribe la identidad al dar de alta a un paciente.
- **Lo que NO se amplió:** `GET /patients/:id/identity`, la única ruta que devuelve el DOCUMENTO,
  sigue cerrada a quien diagnostica; los anexos, las exportaciones CSV y los reportes PDF siguen
  usando siempre el código; y cada lectura de identidad sigue quedando en la traza (RNF-02).
  Declarado en `acne-infra/TRACEABILITY.md`, sección de notas de seguridad abiertas.

### Added

- **`CatalogConsistencyService` comprueba también la matriz `roles_permisos`**, par a par. Antes
  verificaba que existieran los mismos códigos de rol y de permiso, que es lo que no decide nada: un
  permiso concedido en `ROLE_PERMISSIONS` y olvidado en la migración no rompe ninguna clave foránea,
  solo hace que la base declare una política de autorización distinta de la que el servidor aplica.

### Fixed

- **`GET /audit/iia-check`, el Anexo 4 y el Anexo 5 devolvían 500.** Tres `QueryBuilder` nombraban
  COLUMNAS crudas (`inference.latency_ms`, `d.case_id`, `timing.duration_seconds`) en vez de
  propiedades de la entidad. TypeORM pasa un nombre que no reconoce tal cual a SQL, así que al
  renombrar las columnas a español la consulta murió con `column ... does not exist`. Son cadenas:
  ni el compilador ni el renombrado por identificadores entrecomillados podían verlas. Ahora usan
  las propiedades (`inference.latencyMs`) y unen ENTIDADES en vez de nombres de tabla, que es
  precisamente lo que `@Column({ name })` existe para permitir.
- **`GET /stats/dataset-export?dataset=<inválido>` devolvía 500** con un stack trace donde
  correspondía decir cuáles son los datasets disponibles. Ahora es un 400 que los lista.

### Added

- **Catálogo de nombres de la auditoría** (`common/domain/audit.ts`): las 36 acciones y los 12 tipos
  de entidad de la traza tienen nombre legible, y `GET /audit/logs` los sirve junto al código. El
  código no desaparece —es por lo que se filtra y lo que se cita en un hallazgo— pero deja de ser lo
  único que la pantalla muestra.
- `audit.spec.ts` recorre el código y falla si una acción registrada no tiene nombre, o si el
  catálogo nombra una que ya nadie registra.

### Changed

- **Los estados de cobertura pasan a español**: `covered` → `cubierto`, `partial` → `parcial`,
  `pending` → `pendiente`. Se pintaban en crudo en la matriz de RNF-04, de modo que el jurado leía
  `partial` en un documento en español.
- Los identificadores de módulo del registry de trazabilidad dejan de apuntar a `web:portal/…`, que
  ya no existe. Sincronizado con `acne-infra/TRACEABILITY.md`.

### Changed — una cuenta por rol

- **`seed:admin` crea tres cuentas y no siete**, una por rol. Las otras cuatro eran dermatólogos, y
  el motivo de que existieran era correcto —HE₃ contrasta la satisfacción de cada profesional contra
  una línea base y Shapiro-Wilk necesita al menos tres respondientes— pero el sitio era el
  equivocado: nunca fueron personal del centro, eran relleno del censo de demostración, y mezclarlos
  ahí hacía que el sistema pareciera tener siete personas para tres roles.
- **`seed:study` crea sus propios profesionales**, marcados con la nueva columna
  `usuarios.es_sintetico`, igual que los treinta casos que revisan. El seeder deja de depender de
  `seed:admin` y borrar los datos de demostración se los lleva.
- **El desglose por profesional (RF-OE4-04) respeta `includeSynthetic`.** Antes listaba a todo
  dermatólogo existiera o no, de modo que un tablero con los sintéticos excluidos dibujaba cuatro
  cajas vacías junto a las reales.
- `GET /users` devuelve `isSynthetic`, y la ficha de usuario lo declara.

### Changed — reestructuración del esquema (BREAKING)

- **La base de datos pasa a español y a tercera forma normal.** Una sola migración,
  `1757100000000-EsquemaEspanolNormalizado`, reemplaza a las tres anteriores, que se eliminaron del
  repositorio. No es incremental: hace `DROP` de todo —esquema nuevo y esquema anterior en inglés— y
  reconstruye 47 tablas. Es lo que se pidió explícitamente. Documentado en
  `acne-infra/docs/02_modelo_datos.md`.
- **21 enumeraciones `CHECK` pasan a 23 tablas catálogo** con clave primaria propia y clave foránea
  desde cada tabla transaccional. Antes la lista existía dos veces —en el `CHECK` y en
  `common/domain/`— y añadir una clase IGA era un `ALTER TABLE`; ahora es un `INSERT`, la integridad
  la garantiza el motor y el catálogo se puede consultar, ordenar y unir.
- **Siete columnas `jsonb` se normalizan a tablas hijas**: el vector de probabilidades
  (`probabilidades_inferencia`), la lectura clínica del modelo (`valoraciones_inferencia` +
  `detalles_valoracion`), las 21 respuestas de la anamnesis (`respuestas_anamnesis` +
  `respuestas_anamnesis_opcion`), las observaciones de un indicador, sus ocho descriptivos, el
  bloque de normalidad y el tamaño de efecto de un contraste, y los pares que consumió. «Cuántas
  pacientes declararon embarazo actual» pasa de un *scan* con operadores JSON a un `JOIN`.
  Sobrevive un solo `jsonb`, `registros_auditoria.metadatos`, porque el contexto de una acción es
  genuinamente sin esquema.
- **`consents` gana integridad referencial.** El par `subject_type` + `subject_id` no admitía clave
  foránea: nada impedía un consentimiento apuntando a un `uuid` inexistente. Ahora son
  `paciente_id` y `usuario_id`, ambas nulables con FK real y un `CHECK` de exactamente una.
- **Cinco roles pasan a tres.** `residente` se absorbe en `dermatologo` y `evaluador_estadistico` en
  `admin`: describían turnos de una misma persona, no puestos distintos. La autorización deja de ser
  listas de roles escritas en cada controlador y pasa a una matriz de 12 permisos atómicos
  (`ROLE_PERMISSIONS`), que la base guarda en `roles` / `permisos` / `roles_permisos`. Cada `@Roles`
  se deriva ahora de un permiso, de modo que mover un rol entre grupos no obliga a revisar ocho
  listas y olvidar una.
- **Ejecutar un contraste de hipótesis pasa a ser exclusivo de `admin`.** Leer los indicadores y el
  historial sigue abierto a `dermatologo`: un profesional que no ve sus propios números no puede
  juzgar si la herramienta le ayuda, pero el sujeto de una medición no debe ser quien congela su
  bitácora inmutable.
- **Valores de dominio traducidos**: estado del caso (`draft` → `borrador`…), estado de proceso
  (`pending` → `pendiente`…), grado GAGS (`none` → `sin_acne`…) y tipo de pregunta
  (`single_choice` → `opcion_unica`…). Se conservan en su forma canónica los identificadores que
  cruzan una frontera ajena: los nombres de las pruebas de SciPy, sus argumentos, los *drivers* de
  almacenamiento y los backends del modelo. El grado GAGS cruza a `acne-ai-engine` y se cambió en
  los dos repositorios a la vez.

### Added

- **`CatalogConsistencyService`** — compara al arrancar las 18 listas de `common/domain/` contra sus
  tablas catálogo y **lanza una excepción** si alguna difiere. No advierte: falla. Un desajuste
  significa que las escrituras morirán en una clave foránea de todos modos, y un proceso que muere
  en el arranque delante de quien desplegó es mucho más barato de diagnosticar que uno que muere a
  las tres de la tarde delante de un paciente.
- **`AnamnesisAnswerRepository`** — traduce entre el mapa de respuestas que habla la API y las filas
  que guarda la base, de modo que el DTO que recibe el portal es exactamente el de antes de la
  migración. Lee las 21 respuestas de varias visitas en una sola consulta, en vez de una por fila.

### Fixed

- **El CSV de anamnesis conserva su formato ancho** —una fila por caso, una columna por pregunta—
  ahora que las respuestas viven en `respuestas_anamnesis`. Se reagrupan en SQL antes de aplanarlas,
  de modo que el fichero es idéntico al de antes de la migración. El formato largo habría sido la
  lectura directa del esquema nuevo y es la exportación equivocada: quien quiera un contraste a
  nivel de caso en SPSS o R tendría que pivotarlo de vuelta primero.

### Added

- **`GET /audit/logs/actions`** — las acciones que aparecen en la traza, con su recuento, derivadas
  de las propias filas. El catálogo de acciones no está declarado en ningún sitio (cada una es un
  literal en su punto de llamada), así que una lista escrita a mano habría quedado obsoleta al
  añadir el primer endpoint y el filtro habría ocultado justo los eventos que nadie sabría buscar.
- **Mantenedores de personal y de pacientes.** Filtros por rol, estado y texto en `GET /users`;
  `GET /users/:id`; corrección del correo en `PATCH /users/:id`; **`PATCH /users/me/password`**
  —hasta ahora **nadie** podía cambiar su propia contraseña— y **`POST /users/:id/password-reset`**,
  que genera una y la devuelve una sola vez, sin guardarla en claro ni escribirla en la auditoría.
  Y **`PATCH /patients/:id`**, que no existía: un paciente era inmutable desde su alta, así que un
  nombre mal escrito o un fototipo omitido —el que alimenta la auditoría de equidad de la sección
  8.2— se quedaban así para siempre.
- **`POST /patients/:id/reinstate`**, para deshacer un retiro registrado por error. Exige motivo, a
  diferencia del retiro: los casos vuelven a los datasets y un `indicator_snapshot` anterior dejará
  de coincidir con un recálculo. Deja una tercera fila en `consents` en lugar de borrar la del
  retiro, porque la secuencia completa es la evidencia que pide RNF-07.
- `USER_ROLE_GROUPS` en `GET /meta/catalogs`, derivado de las constantes que ya existían. Sin él el
  portal tendría que escribir `['dermatologo','residente']` a mano para saber qué es «personal
  médico», que es la duplicación que prohíbe la regla de contrato de la sección 4.
- **`no-hard-delete.spec.ts`**: falla el build si aparece un `@Delete` en cualquier controlador.
  Borrar una fila de `users` o `patients` no elimina un registro, invalida en silencio una medición
  —y con `indicator_snapshots` inmutable por RNF-05, deja un indicador publicado que ya no se puede
  reproducir. Las reglas de revisión se olvidan; esta cuesta veinte líneas.
- 19 pruebas nuevas de los dos servicios. Ninguna migración: todo escribe sobre columnas existentes.
- **Las fotografías se criban antes de guardarse.** `ImagesService.upload` consulta al motor y
  rechaza con 422 lo que no sea un rostro humano evaluable — antes de cifrar y persistir, porque
  rechazar después dejaría la basura en disco y en la ficha. Afecta por igual a la subida del
  escritorio y a la del teléfono por QR.
  Los problemas de calidad —encuadre, luz, enfoque— **avisan pero no bloquean**, y viajan en
  `warnings` hasta quien sostiene la cámara, que es el único momento en que sirven de algo.
  Si el motor no responde, la imagen se admite y queda un aviso en el log: negar la admisión de un
  paciente real porque una API parpadeó es el peor de los dos errores.
  `IMAGE_SCREENING_ENABLED=false` lo desactiva sin tocar código.
- `AiEngineModule`, para que `ImagesModule` hable con el motor sin depender de `InferenceModule`,
  que ya depende de él.
- 8 pruebas de los mensajes, incluida una que comprueba que **ninguno menciona la enfermedad**: se
  leen en la admisión, que ocurre también en pretest.
- **La anamnesis viaja con la fotografía** (`src/inference/clinical-context.ts`). Se compone en el
  momento de ejecutar el trabajo, no al encolarlo, porque la historia se sigue completando mientras
  el trabajo espera en la cola. Lleva edad, sexo, fototipo y las respuestas con la redacción
  literal del catálogo; **no lleva nombre, documento ni fecha de nacimiento** (RF-TR-03), y una
  prueba inspecciona el payload completo para que una fuga añadida más tarde falle ahí.
  Si la anamnesis no se puede leer, la inferencia sigue adelante solo con la imagen: el
  cuestionario es una extensión sin requerimiento numerado detrás, la graduación es OE2.
- Columna `ai_inferences.assessment` (`jsonb`, migración `1756950000000`) con la lectura razonada
  del modelo, y `AiAssessmentDto` para que su forma llegue al portal por el cliente OpenAPI.
  Nula para un backend que solo mira píxeles, que es el valor honesto.
- 14 pruebas de la composición del contexto clínico.
- `src/scripts/evaluate-backend.ts` (`npm run evaluate:backend`) — reencola los 30 casos sintéticos
  por la **cola real** y publica TPD contra `ground_truth_iga`, matriz de confusión de cinco clases,
  F1 por clase, comparación contra el diagnóstico manual de pretest, latencia mediana y p95 frente a
  RNF-01, y los fallos de validación. `EVAL_REPORT_ONLY=1` informa sin volver a gastar cuota.

### Changed

- `model_backend` admite `'gemini'` y `IiaCheckResponse` transporta `model_kind` hasta
  `GET /audit/iia-check`. No hace falta migración: la columna es `varchar(16)` sin `CHECK`.

### Fixed

- **El `search` de `GET /patients` se ignoraba en silencio para los roles sin identidad.** `admin` y
  `evaluador_estadistico` recibían el censo entero con cualquier término que escribieran. Había dos
  métodos de listado y solo uno aplicaba el filtro; ahora hay uno, y `revealIdentity` decide qué se
  descifra, no si la búsqueda funciona.
- El retiro de paciente **no validaba su cuerpo**: leía `@Body('notes')` suelto, y un parámetro sin
  metatipo es invisible para el `ValidationPipe`, así que `forbidNonWhitelisted` no le aplicaba.
- `PATCH /users/:id` rechaza que un administrador se desactive o se cambie el rol a sí mismo, y ya
  no confunde el correo propio con uno duplicado al reguardar el formulario.


- **Las imágenes sintéticas no guardaban ninguna relación con su etiqueta.**
  `buildSyntheticFaceImage` sorteaba de 6 a 15 manchas con el generador aleatorio, mientras
  `ground_truth_iga` se sorteaba aparte: un caso `severo` podía tener siete manchas tenues y uno
  `leve`, catorce. La correlación entre imagen y etiqueta era **cero**, de modo que ningún modelo
  podía superar el azar y cualquier TPD medido sobre ellas era ruido. Ahora el número, el tamaño y
  la intensidad de las lesiones escalan con la clase IGA.
  La restricción que gobierna la corrección: **el número de llamadas a `rng()` es constante sea cual
  sea la clase**. Los tiempos de revisión, los diagnósticos, las jornadas y los cuestionarios beben
  del mismo generador; si el flujo se desplazara, TRM, TPD, TCAD y los cuatro contrastes cambiarían
  de valor sin que nadie los hubiera tocado. Hay una prueba dedicada a eso.

### Removed

- `UsersService.findDiagnosingStaff()`, sin ningún llamador y equivalente al nuevo filtro por rol.

## [0.1.0] — 2026-08-31

### Added

- **Dominio** (`common/domain/`) — fuente única de verdad: escala IGA y GAGS, modos de estudio y
  máquina de estados del caso, roles, definiciones y metas de TRM/TPD/TSP/TCAD, los 8 ítems Likert
  verbatim del Anexo 6, enunciados de HE₁–HE₄ y disclaimer de RNF-06.
- **Esquema clínico** (migración `InitialSchema`) — 15 tablas con 34 CHECK, 18 claves foráneas y
  comentarios SQL que declaran a qué objetivo sirve cada una.
- **`auth/` + `users/`** — JWT de acceso y refresco, cuatro roles, `study_mode` por usuario
  (RF-TR-01, RF-TR-02).
- **`patients/`** — pacientes anonimizados con identidad cifrada AES-256-GCM, consentimiento
  informado y derecho a retiro (RF-TR-03, RNF-07).
- **`cases/` + `images/`** — casos con apertura cronometrada e imágenes cifradas en reposo,
  servidas por token firmado con TTL de 15 min (RNF-02).
- **`study/`** — `StudyModeGuard`: las rutas de IA devuelven 403 en pretest; Anexo 4 digitalizado.
- **`inference/`** — cliente del motor de IA, cola respaldada por PostgreSQL con `FOR UPDATE SKIP
  LOCKED` y reintentos.
- **`diagnoses/`** — diagnóstico del especialista, cierre del cronómetro y Anexo 5 digitalizado.
- **`sessions/`** — jornadas de trabajo y Anexo 7 digitalizado (OE4).
- **`surveys/`** — cuestionario Likert con disparo automático a los N casos postest (OE3).
- **`indicators/`** — TRM, TPD, TSP y TCAD por modo y por profesional, matriz de confusión de 5
  clases y alertas de meta; snapshots inmutables (RNF-05).
- **`stats/`** — `POST /stats/hypothesis` y `/hypothesis/all` con la regla Shapiro-Wilk → t pareada
  o Wilcoxon, y `GET /stats/dataset-export` en CSV restringido a `admin`.
- **`reports/`** — los cuatro PDF de la Sección 11 con Playwright y disclaimer regulatorio.
- **`audit/`** — `GET /audit/thesis-coverage` y `GET /audit/iia-check`, más la traza append-only.
- **`meta/`** — `GET /meta/catalogs`, que sirve al frontend las constantes de instrumento que
  OpenAPI no puede generar.
- **Seeds** — `seed:admin` (cuentas con contraseñas aleatorias de un solo uso) y `seed:study`
  (30 casos sintéticos reproducibles con imágenes PNG cifradas y Grad-CAM simulado).
- **Anamnesis de acné por visita** (`GET`/`PUT /cases/:id/anamnesis`,
  `GET /patients/:id/anamnesis/latest`). 21 preguntas recortadas del cuestionario modular de
  teleconsulta del asesor, quedándose solo con lo que cambia la evaluación de acné, con rama
  hormonal para mujeres desde los 18 años. El catálogo vive en `common/domain/anamnesis.ts` y se
  sirve por `GET /meta/catalogs`, igual que el Likert del Anexo 6: el frontend lo **renderiza**, no
  lo reescribe. Las respuestas se guardan como `jsonb` validado contra ese catálogo —claves
  desconocidas, opciones inexistentes y preguntas que no aplican al paciente se rechazan con 400— y
  cada fila lleva la versión del cuestionario, sin la cual el registro no sería reproducible
  (RNF-03, RNF-05).
  **Es una extensión solicitada, no un RF del documento maestro**, y así se declara en
  `TRACEABILITY.md`. Se muestra idéntica en pretest y postest, y se registra en el alta del caso
  —antes de `POST /cases/:id/open`— para que no entre en la ventana cronometrada de OE1.
- **Captura de fotografías desde el móvil por código QR** (`api:capture`). Cierra el hueco que la
  Sección 9.3 dejó abierto: pedía «envío al centro» desde la PWA sin decir cómo se ata un teléfono a
  un caso. `POST /capture-sessions` devuelve **una sola vez** un token de 32 bytes del que la base
  guarda solo su SHA-256; el teléfono lo usa en dos rutas públicas y deliberadamente estrechas —leer
  el código del caso y la lista de tomas, y **añadir** una imagen— que nunca leen, listan ni borran,
  y que jamás revelan el nombre del paciente (RF-TR-03). TTL de 15 min, tope de 8 fotografías,
  revocación manual y **autorrevocación al abrir la ficha**: a partir de t0 corre el cronómetro y las
  fotos ya no pertenecen al ingreso.
- **Protocolo fotográfico**: `case_images.shot_key` con las tres tomas obligatorias (general,
  acercamiento, borde) y las adicionales de acné. Nulo en las imágenes anteriores y en las
  sintéticas, que no lo siguieron.
- **Rol `tecnico`** (RF-TR-02): realiza el ingreso —paciente, anamnesis, sesión de fotos— y no
  diagnostica ni ve la sugerencia del modelo. `aiVisible` deja de depender solo del modo de estudio y
  pasa a ser rol **y** modo, porque un técnico opera en `produccion`, donde la IA está desbloqueada.
- **`GET /stats/dataset-export?dataset=anamnesis`**: una fila por caso y una columna por pregunta,
  referenciada solo por código (RF-TR-03) y restringida a `admin` (RF-TR-02).

### Changed

- **Barrido de autorización.** Añadir un quinto rol ensancha de golpe toda ruta sin `@Roles`, que el
  encabezado de `app.module.ts` daba por protegida. Se declaró explícitamente el rol de cada handler
  y se cerró al técnico la superficie del estudio (indicadores, estadística, anexos, jornadas,
  encuesta, reportes, auditoría). Lo sostiene una prueba, `route-authorisation.spec.ts`, que falla
  si un endpoint nuevo queda sin `@Roles` ni `@Public` — el barrido a mano no se repite solo.
- **Historia clínica longitudinal del paciente.** `GET /patients/:id/history` devuelve la
  cronología completa de visitas de una persona —severidad IGA de cada una, diagnósticos firmados,
  cronometrías de ambas condiciones, imágenes y sugerencia del modelo— más un resumen de evolución
  (`trend`, `severityDelta`, `averageReviewMinutes`). Es la vista **clínica**, complementaria a la
  bandeja de casos: la bandeja se organiza en torno al experimento y responde «qué falta revisar»,
  esta responde lo que el dermatólogo pregunta en un control, «cómo ha evolucionado este paciente».
  El bloque de IA llega en `null` para quien opera en pretest, igual que en la ficha de caso
  (RF-TR-01), y cada consulta queda registrada como `patient.history.read`.
  `GET /patients` incorpora además el resumen por paciente (`caseCount`, `lastVisitAt`,
  `lastSeverity`) para poder triar el registro de un vistazo.
- **La siembra sintética reparte los 30 casos entre ~21 pacientes.** Antes generaba un paciente por
  caso, de modo que ninguna historia tenía seguimiento y la curva de evolución quedaba
  estructuralmente vacía. El censo que fija la tesis es de 30 **casos**, no de 30 pacientes, así
  que repartirlos es a la vez más realista y fiel al diseño: algunos pacientes acumulan dos o tres
  visitas separadas ~45 días, con una trayectoria de severidad que suele mejorar un escalón IGA
  bajo tratamiento. Las 30 unidades pareadas de HE₁, HE₂ y los indicadores no cambian.
  Los nombres se sortean ahora dentro del sexo registrado; sorteados por separado producían filas
  como «José … femenino», que se leen como un fallo de integridad en cuanto se muestra el registro.
- **Nombre del paciente visible para el profesional tratante, y búsqueda por nombre.**
  `GET /patients` y `GET /cases` devuelven `fullName` / `patientName` descifrado cuando el
  solicitante es `dermatologo` o `residente`, y `null` para el resto de roles. Ambos aceptan
  `search`, que filtra por nombre, código de paciente o código de caso.
  RF-TR-03 cifra la identidad y la reserva al profesional tratante; no le pide elegir entre
  códigos, que es justamente como se abre el caso equivocado. La anonimización se mantiene donde
  importa: **anexos, exportación CSV y reportes PDF siguen usando solo códigos**, verificado.
  El filtrado ocurre en memoria tras descifrar, porque el nombre es ciphertext y ningún `LIKE` de
  SQL lo alcanza; es suficiente para el censo de 30 casos, pero un registro en producción
  necesitaría un índice ciego.
- Los listados con identidad registran **una** entrada de auditoría por consulta
  (`patient.list.identity`, `case.list.identity`) en lugar de una por fila, para no sepultar los
  eventos puntuales de `patient.identity.read` bajo el ruido de cada refresco.

### Fixed

- **Registrar un paciente fallaba con 500 en cualquier base sembrada.** `nextPatientCode` tomaba el
  máximo **lexicográfico** de `patient_code` y le quitaba el prefijo. Desde que el seeder introdujo
  códigos sintéticos con letra (`PAC-2026-S021`), esos ordenaban por encima de todos los reales,
  `Number("S021")` daba `NaN`, el contador reiniciaba en 1 y el `INSERT` chocaba con el
  `PAC-2026-0001` ya existente. Fallaba **todo paciente registrado después del primero**, en todas
  las bases de demostración. El defecto era idéntico en `nextCaseCode`. Ahora `nextSequentialCode`
  toma el máximo NUMÉRICO ignorando los códigos que no son solo dígitos, y `withCodeRetry`
  convierte la carrera entre dos ingresos simultáneos en un segundo intento en lugar de un error
  delante del paciente. Con pruebas de regresión de ambos defectos.
- **La subida de imágenes creía la cabecera del cliente.** `validate()` comprobaba el `mimetype`
  declarado en el multipart, que es simplemente lo que el cliente escribió. Tolerable detrás de un
  JWT; no en la ruta pública de captura móvil. Ahora el formato se decide leyendo los bytes del
  archivo (`image-sniffer.ts`), y un JPEG truncado —una foto que se cortó al caerse el wifi— se
  rechaza en lugar de quedar a medias en el registro clínico.
- **Cola de inferencia: trabajos fantasma.** `claimNext` interpretaba mal el resultado de
  TypeORM para `UPDATE ... RETURNING`, que puede llegar como `[filas, contador]`. Con la cola
  vacía, `raw[0]` era un arreglo vacío —no `undefined`— y superaba la comprobación, produciendo un
  "trabajo" con todos los campos `undefined`. Como TypeORM descarta silenciosamente las
  condiciones `undefined` de un `where`, el worker marcaba como `running` una inferencia ajena ya
  completada, una vez por cada ciclo de sondeo. Se normaliza y valida la fila devuelta, y se
  añaden pruebas de regresión.
- **Inferencias fallidas atascadas.** La recuperación tras un fallo filtraba por `status =
  'pending'`, pero `execute` ya había movido la fila a `running`, de modo que ninguna inferencia
  fallida llegaba a marcarse como tal. Ahora contempla ambos estados.
