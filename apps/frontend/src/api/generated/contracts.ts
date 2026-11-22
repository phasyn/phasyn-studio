/* eslint-disable */
/**
 * 由 scripts/gen-contracts.mjs 從 contracts/component.schema.json 產生；請勿手改。
 * 重新產生：pnpm --filter @phasyn-studio/frontend gen:types
 */

/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "ComponentState".
 */
export type ComponentState = "stopped" | "loading" | "ready" | "busy" | "stopping" | "error";
/**
 * 內網HTTP origin；无path/query；不帶密碼；IPv6用[]。解析仍需HTTP URL parser。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "Endpoint".
 */
export type Endpoint = string;
/**
 * x-phasyn-extension：元件的載入方式。resident（預設，沒有設定時也是）＝只由人或 autostart 啟停，主控不自動載入、不自動卸載、不為了互斥群組替換它；on_demand＝用到才載入：run 的步驟要用它而它已停止時，主控先自動啟動、等到 ready 再送出呼叫，閒置超過 idle_unload_seconds 後主控自動停止它（忙碌或有排隊中的步驟要用時不停止）。
 */
export type LoadPolicy = "resident" | "on_demand";
/**
 * x-phasyn-extension：元件 instance 在介面上的分類資料夾（以 / 分層，最多 6 層）；只影響顯示，不影響執行。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "ComponentFolder".
 */
export type ComponentFolder = string;
/**
 * x-phasyn-extension：元件的載入方式。resident（預設，沒有設定時也是）＝只由人或 autostart 啟停，主控不自動載入、不自動卸載、不為了互斥群組替換它；on_demand＝用到才載入：run 的步驟要用它而它已停止時，主控先自動啟動、等到 ready 再送出呼叫，閒置超過 idle_unload_seconds 後主控自動停止它（忙碌或有排隊中的步驟要用時不停止）。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "LoadPolicy".
 */
export type LoadPolicy1 = "resident" | "on_demand";
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "TypedValue".
 */
export type TypedValue =
  | {
      type_id: string;
      /**
       * JSON value; NaN/Infinity forbidden. Bound by body size and provider schema.
       */
      value: {
        [k: string]: unknown | undefined;
      };
    }
  | {
      type_id: string;
      file: FileRef;
    };
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "Binding".
 */
export type Binding =
  | {
      from_input: string;
    }
  | {
      from_step: string;
      output: string;
    }
  | {
      literal: TypedValue;
    };
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "Quality".
 */
export type Quality = "instrumented" | "sampled" | "trace" | "derived" | "unavailable" | "not_applicable" | "synthetic";
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "Run".
 */
export type Run = Run1;
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "RecordingEvent".
 */
export type RecordingEvent =
  | {
      recording_id: string;
      stream_id: string;
      seq: number;
      node_id: string;
      component_id: string;
      process_instance_id: string;
      run_id: string | null;
      call_id: string | null;
      occurred_at: string;
      monotonic_ns: string;
      level: "debug" | "info" | "warning" | "error";
      kind: "span";
      data: SpanData;
    }
  | {
      recording_id: string;
      stream_id: string;
      seq: number;
      node_id: string;
      component_id: string;
      process_instance_id: string;
      run_id: string | null;
      call_id: string | null;
      occurred_at: string;
      monotonic_ns: string;
      level: "debug" | "info" | "warning" | "error";
      kind: "transfer";
      data: TransferData;
    }
  | {
      recording_id: string;
      stream_id: string;
      seq: number;
      node_id: string;
      component_id: string;
      process_instance_id: string;
      run_id: string | null;
      call_id: string | null;
      occurred_at: string;
      monotonic_ns: string;
      level: "debug" | "info" | "warning" | "error";
      kind: "sample";
      data: SampleData;
    }
  | {
      recording_id: string;
      stream_id: string;
      seq: number;
      node_id: string;
      component_id: string;
      process_instance_id: string;
      run_id: string | null;
      call_id: string | null;
      occurred_at: string;
      monotonic_ns: string;
      level: "debug" | "info" | "warning" | "error";
      kind: "step";
      data: StepData;
    }
  | {
      recording_id: string;
      stream_id: string;
      seq: number;
      node_id: string;
      component_id: string;
      process_instance_id: string;
      run_id: string | null;
      call_id: string | null;
      occurred_at: string;
      monotonic_ns: string;
      level: "debug" | "info" | "warning" | "error";
      kind: "log";
      data: LogData;
    }
  | {
      recording_id: string;
      stream_id: string;
      seq: number;
      node_id: string;
      component_id: string;
      process_instance_id: string;
      run_id: string | null;
      call_id: string | null;
      occurred_at: string;
      monotonic_ns: string;
      level: "debug" | "info" | "warning" | "error";
      kind: "notice";
      data: RecorderNotice;
    };
/**
 * x-phasyn-extension：Studio 的運算路由＝一個已保存的元件組合（pipeline_id）。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioRouteId".
 */
export type StudioRouteId = string;
/**
 * x-phasyn-extension：專案選用的插件貢獻（規則或生成設定）的引用。內建包的貢獻是不帶前綴的 id（例如 no-fighting-game，永久如此）；其他包是 <plugin_id>/<貢獻 id>。主控的登錄表（GET /api/studio/plugins）在每個貢獻上給出它的引用。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioPluginRef".
 */
export type StudioPluginRef = string;
/**
 * Ordered clip effect. effect_id is stable and unique within its clip. Disabled effects retain their settings. Color uses FFmpeg eq semantics; blur radius is Gaussian sigma in sequence pixels; chroma key uses RGB distance. Optional keyframes animate only the parameters allowed by that effect kind.
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "TimelineEffect".
 */
export type TimelineEffect =
  | {
      effect_id: string;
      enabled: boolean;
      kind: "color";
      brightness: number;
      contrast: number;
      saturation: number;
      /**
       * Optional parameter automation in clip-local output frames, after retiming and holds. Missing or empty channels use the fixed parameter value.
       */
      keyframes?: {
        /**
         * @maxItems 128
         */
        brightness?: TimelineKeyframe[];
        /**
         * @maxItems 128
         */
        contrast?: TimelineKeyframe[];
        /**
         * @maxItems 128
         */
        saturation?: TimelineKeyframe[];
      };
    }
  | {
      effect_id: string;
      enabled: boolean;
      kind: "blur";
      radius: number;
      /**
       * Optional parameter automation in clip-local output frames, after retiming and holds. Missing or empty channels use the fixed parameter value.
       */
      keyframes?: {
        /**
         * @maxItems 128
         */
        radius?: TimelineKeyframe[];
      };
    }
  | {
      effect_id: string;
      enabled: boolean;
      kind: "chroma_key";
      color: string;
      similarity: number;
      blend: number;
      /**
       * Optional parameter automation in clip-local output frames, after retiming and holds. Missing or empty channels use the fixed parameter value.
       */
      keyframes?: {
        /**
         * @maxItems 128
         */
        similarity?: TimelineKeyframe[];
        /**
         * @maxItems 128
         */
        blend?: TimelineKeyframe[];
      };
    }
  | {
      effect_id: string;
      enabled: boolean;
      kind: "glow";
      /**
       * Strength of the added glow; 0 = off.
       */
      intensity: number;
      /**
       * Blur radius of the glow in sequence pixels.
       */
      radius: number;
      /**
       * Luma above which pixels glow.
       */
      threshold: number;
      /**
       * Optional parameter automation in clip-local output frames, after retiming and holds. Missing or empty channels use the fixed parameter value.
       */
      keyframes?: {
        /**
         * @maxItems 128
         */
        intensity?: TimelineKeyframe[];
        /**
         * @maxItems 128
         */
        radius?: TimelineKeyframe[];
        /**
         * @maxItems 128
         */
        threshold?: TimelineKeyframe[];
      };
    }
  | {
      effect_id: string;
      enabled: boolean;
      kind: "rgb_split";
      /**
       * Channel offset in sequence pixels; 0 = off.
       */
      offset: number;
      /**
       * Direction of the red channel in degrees, 0 = to the right, 90 = down.
       */
      angle: number;
      /**
       * Optional parameter automation in clip-local output frames, after retiming and holds. Missing or empty channels use the fixed parameter value.
       */
      keyframes?: {
        /**
         * @maxItems 128
         */
        offset?: TimelineKeyframe[];
        /**
         * @maxItems 128
         */
        angle?: TimelineKeyframe[];
      };
    }
  | {
      effect_id: string;
      enabled: boolean;
      kind: "vignette";
      /**
       * Darkness at the corners; 0 = off.
       */
      amount: number;
      /**
       * Width of the falloff; larger reaches further inward.
       */
      softness: number;
      /**
       * Optional parameter automation in clip-local output frames, after retiming and holds. Missing or empty channels use the fixed parameter value.
       */
      keyframes?: {
        /**
         * @maxItems 128
         */
        amount?: TimelineKeyframe[];
        /**
         * @maxItems 128
         */
        softness?: TimelineKeyframe[];
      };
    }
  | {
      effect_id: string;
      enabled: boolean;
      kind: "grain";
      /**
       * Noise strength; 0 = off.
       */
      amount: number;
      /**
       * Optional parameter automation in clip-local output frames, after retiming and holds. Missing or empty channels use the fixed parameter value.
       */
      keyframes?: {
        /**
         * @maxItems 128
         */
        amount?: TimelineKeyframe[];
      };
    }
  | {
      effect_id: string;
      enabled: boolean;
      kind: "directional_blur";
      /**
       * Blur length in sequence pixels; 0 = off.
       */
      length: number;
      /**
       * Blur direction in degrees, 0 = horizontal.
       */
      angle: number;
      /**
       * Optional parameter automation in clip-local output frames, after retiming and holds. Missing or empty channels use the fixed parameter value.
       */
      keyframes?: {
        /**
         * @maxItems 128
         */
        length?: TimelineKeyframe[];
        /**
         * @maxItems 128
         */
        angle?: TimelineKeyframe[];
      };
    }
  | {
      effect_id: string;
      enabled: boolean;
      kind: "sharpen";
      /**
       * Sharpening strength; 0 = off.
       */
      amount: number;
      /**
       * Optional parameter automation in clip-local output frames, after retiming and holds. Missing or empty channels use the fixed parameter value.
       */
      keyframes?: {
        /**
         * @maxItems 128
         */
        amount?: TimelineKeyframe[];
      };
    };
/**
 * x-phasyn-extension：media.sequence.v1 的值；media.concat 依序裁切接合。audio_track（選填）＝匯出的聲音改用指定檔案的音軌（MediaSequenceAudioTrack）；沒有 audio_track 時聲音照原本的方式由片段產生。fit（選填）＝片段與序列尺寸不同時的縮放方式。 timeline selects multitrack composition; clips must then be empty and audio_track is forbidden. Legacy nonempty clips retain their original behavior. render_range is optional with timeline and trims the final composite and mixed audio to an exact sequence-frame interval; clip animation and transitions retain their original phase.
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "MediaSequence".
 */
export type MediaSequence = MediaSequence1;
/**
 * x-phasyn-extension：插件包的 id（反向網域式、全小寫，例如 com.example.sakuga-tools）。phasyn. 開頭保留給隨主程式提供的內建包；「內建」由來源決定，不由 manifest 決定。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioPluginId".
 */
export type StudioPluginId = string;
/**
 * x-phasyn-extension：生成設定的一項要求：渲染規劃時 field 的實際值必須是 in 之一，否則不能渲染（兩邊的值都不會被改）。field 是白名單：format（專案畫面的寬高）、frames（鏡頭影格數）、steps／video_shift／audio_shift（DiT 步驟實際使用的值）、route_capability（鏡頭元件組合的能力）、reference_video_short_edge（元件組合的參考影片短邊）。seed、模型、dtype、裝置與 DiT 的選擇無法表達。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioPluginGenerationRequirement".
 */
export type StudioPluginGenerationRequirement =
  | {
      id: string;
      field: "format";
      /**
       * @minItems 1
       * @maxItems 16
       */
      in: {
        width: number;
        height: number;
      }[];
      message: StudioPluginText;
    }
  | {
      id: string;
      field: "frames";
      /**
       * @minItems 1
       * @maxItems 16
       */
      in: number[];
      message: StudioPluginText;
    }
  | {
      id: string;
      field: "steps";
      /**
       * @minItems 1
       * @maxItems 16
       */
      in: number[];
      message: StudioPluginText;
    }
  | {
      id: string;
      field: "video_shift";
      /**
       * @minItems 1
       * @maxItems 16
       */
      in: number[];
      message: StudioPluginText;
    }
  | {
      id: string;
      field: "audio_shift";
      /**
       * @minItems 1
       * @maxItems 16
       */
      in: number[];
      message: StudioPluginText;
    }
  | {
      id: string;
      field: "route_capability";
      /**
       * @minItems 1
       * @maxItems 16
       */
      in: ("t2va" | "fl2va" | "ref2va")[];
      message: StudioPluginText;
    }
  | {
      id: string;
      field: "reference_video_short_edge";
      /**
       * @minItems 1
       * @maxItems 16
       */
      in: number[];
      message: StudioPluginText;
    };
/**
 * x-phasyn-extension：圖片反推的八個場景區段（prompt reconstruction 八區段）。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "PromptSectionKey".
 */
export type PromptSectionKey =
  "subject" | "action" | "composition" | "environment" | "lighting" | "appearance" | "style" | "visible_text";
/**
 * x-phasyn-extension：反推研究語言；zh-TW 時 text_zh_tw 是實際生成文字，en 時 text_en。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "PromptLanguage".
 */
export type PromptLanguage = "en" | "zh-TW";
/**
 * x-phasyn-extension：任務開始時凍結的要求；生成設定 settings 是送給 t2i 接線的參數快照（不在這裡解讀）。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "PromptTaskRequest".
 */
export type PromptTaskRequest =
  | {
      kind: "analyze";
    }
  | {
      kind: "refine";
      instruction: string;
    }
  | {
      kind: "render";
      /**
       * @minItems 1
       * @maxItems 2
       */
      variants: ("core" | "detailed")[];
      /**
       * @minItems 1
       * @maxItems 8
       */
      seeds: number[];
      settings: {
        [k: string]: unknown | undefined;
      };
      deadline_seconds?: number;
    }
  | {
      kind: "reconstruct";
      /**
       * @minItems 1
       * @maxItems 4
       */
      search_seeds: number[];
      /**
       * @minItems 2
       * @maxItems 4
       */
      holdout_seeds: number[];
      max_rounds: number;
      max_images: number;
      max_vision_operations: number;
      stop_after_no_improvement: number;
      settings: {
        [k: string]: unknown | undefined;
      };
      deadline_seconds?: number;
    };
/**
 * x-phasyn-extension：任務的結果參照（result_refs）；比較與分數直接內嵌，刪除 vision run 後仍可閱讀。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "PromptTaskResult".
 */
export type PromptTaskResult =
  | {
      kind: "caption";
      run_id: string;
      caption: string;
    }
  | {
      kind: "version";
      version_id: string;
      run_id: string | null;
    }
  | {
      kind: "render";
      version_id: string;
      variant: "core" | "detailed";
      seed: number;
      split: "search" | "holdout" | "manual";
      round: number;
      run_id: string;
      state: "succeeded" | "failed" | "cancelled" | "interrupted" | "unknown";
      image: FileRef | null;
      image_asset: {
        [k: string]: unknown | undefined;
      } | null;
      error: ApiErrorBody | null;
    }
  | {
      kind: "evaluation";
      version_id: string;
      variant: "core" | "detailed";
      seed: number;
      split: "search" | "holdout" | "manual";
      round: number;
      render_run_id: string;
      run_id: string;
      comparison: PromptComparison;
      score: PromptScore;
    }
  | {
      kind: "pairwise";
      round: number;
      run_id: string;
      seed: number;
      incumbent: {
        version_id: string;
        variant: "core" | "detailed";
      };
      challenger: {
        version_id: string;
        variant: "core" | "detailed";
      };
      ab: PromptPairwise;
      ba: PromptPairwise;
      confirmed: boolean;
    };
/**
 * add needs text and start_frame (three seconds unless end_frame is given); update and remove need caption_id; import_srt appends the captions of an SRT text; clear removes every caption. import_transcript maps a verified speech.transcript.v1 output to one clip and preserves manual revisions.
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "TimelineCommandCaption".
 */
export type TimelineCommandCaption = TimelineCommandCaption1;
/**
 * One edit of POST /api/studio/projects/{project_id}/timeline/commands, selected by op. Frames are integers in sequence time unless stated; clip ranges are [in_frame,out_frame) in source frames.
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioTimelineCommand".
 */
export type StudioTimelineCommand =
  | TimelineCommandAssemble
  | TimelineCommandPlace
  | TimelineCommandMove
  | TimelineCommandTrim
  | TimelineCommandSlip
  | TimelineCommandSlide
  | TimelineCommandSplit
  | TimelineCommandRemove
  | TimelineCommandSetClip
  | TimelineCommandTransition
  | TimelineCommandAddText
  | TimelineCommandAddAdjustment
  | TimelineCommandTrack
  | TimelineCommandMarker
  | TimelineCommandCaption
  | TimelineCommandWorkArea
  | TimelineCommandMaster
  | TimelineCommandJoin
  | TimelineCommandRearrange
  | TimelineCommandReconcile
  | TimelineCommandSetEnabled
  | TimelineCommandRangeCandidate
  | TimelineCommandCollectOutput;
/**
 * x-phasyn-extension：可回收空間的類別。runs＝沒有任何專案（take、素材庫、時間軸、匯出）、草稿計畫、反推研究或 inference preset 引用的已結束 run（連同它產生的檔案與主控紀錄副本）；files＝主控與 Node 上沒有任何引用的已發布檔；remote_cache＝Node 為執行而下載的 files/remote 副本，來源 Node 仍有同一份檔案（可重新下載）且沒有執行中的 run 需要；latents＝已解碼完成的 take 的中間 latent（刪除後無法從 latent 重新解碼或細修）；recordings＝超過指定天數的效能紀錄（主控副本與 Node 本機）。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StorageCategory".
 */
export type StorageCategory = "runs" | "files" | "remote_cache" | "latents" | "recordings";

export interface PhasynStudioContracts {
  ApiErrorBody?: ApiErrorBody;
  ExclusiveGroupDetails?: ExclusiveGroupDetails;
  Endpoint?: Endpoint;
  CostProfile?: CostProfile;
  CostProfileList?: CostProfileList;
  CostProfileStage?: CostProfileStage;
  Device?: Device;
  RecorderConfig?: RecorderConfig;
  Precision?: Precision;
  PartOverride?: PartOverride;
  LoadSettings?: LoadSettings;
  InstanceSettings?: InstanceSettings;
  InstanceDefinition?: InstanceDefinition;
  SettingsPatch?: SettingsPatch;
  SettingsView?: SettingsView;
  Part?: Part;
  Port?: Port;
  ComponentState?: ComponentState;
  ComponentDescriptor?: ComponentDescriptor;
  NodeSnapshot?: NodeSnapshot;
  DirectoryEntry?: DirectoryEntry;
  RegistrationAck?: RegistrationAck;
  Catalog?: Catalog;
  CatalogLite?: CatalogLite;
  NodeSnapshotLite?: NodeSnapshotLite;
  ComponentDescriptorLite?: ComponentDescriptorLite;
  FileRef?: FileRef;
  TypedValue?: TypedValue;
  Binding?: Binding;
  Step?: Step;
  Pipeline?: Pipeline;
  Origin?: Origin;
  RunRequest?: RunRequest;
  InvokeRequest?: InvokeRequest;
  EffectiveContext?: EffectiveContext;
  InvokeResult?: InvokeResult;
  Run?: Run;
  RunStepState?: RunStepState;
  RunStepPreview?: RunStepPreview;
  RunStepPreviewNotice?: RunStepPreviewNotice;
  RunStepPreviewAck?: RunStepPreviewAck;
  ControlRequest?: ControlRequest;
  CancelRequest?: CancelRequest;
  CancelResult?: CancelResult;
  Quality?: Quality;
  Metric?: Metric;
  RecordingContext?: RecordingContext;
  RecordingCost?: RecordingCost;
  RecordingCostStage?: RecordingCostStage;
  SpanData?: SpanData;
  TransferData?: TransferData;
  SampleData?: SampleData;
  StepData?: StepData;
  LogData?: LogData;
  RecorderNotice?: RecorderNotice;
  RecordingEvent?: RecordingEvent;
  RecordingSummary?: RecordingSummary;
  Recording?: Recording;
  RecordingStream?: RecordingStream;
  EventBatch?: EventBatch;
  BatchAck?: BatchAck;
  EventPage?: EventPage;
  RecordingPage?: RecordingPage;
  Comparison?: Comparison;
  FetchHistoryRequest?: FetchHistoryRequest;
  FetchHistoryResult?: FetchHistoryResult;
  ControllerConfig?: ControllerConfig;
  RuntimeEntry?: RuntimeEntry;
  NodeConfig?: NodeConfig;
  NodeAdmission?: NodeAdmission;
  Rational?: Rational;
  TensorDescriptor?: TensorDescriptor;
  FinalLatentManifest?: FinalLatentManifest;
  LatentRef?: LatentRef;
  Asset?: Asset;
  ImageAsset?: ImageAsset;
  FrameEvidence?: FrameEvidence;
  SceneEntity?: SceneEntity;
  SceneEvent?: SceneEvent;
  SceneDocument?: SceneDocument;
  CaptionPair?: CaptionPair;
  DatasetManifest?: DatasetManifest;
  ListPipelines?: ListPipelines;
  ListRuns?: ListRuns;
  ListComponents?: ListComponents;
  Preset?: Preset;
  PresetList?: PresetList;
  ControllerInfo?: ControllerInfo;
  ProviderInfo?: ProviderInfo;
  ProviderList?: ProviderList;
  StudioTake?: StudioTake;
  StudioShot?: StudioShot;
  StudioExport?: StudioExport;
  StudioProject?: StudioProject;
  StudioProjectSummary?: StudioProjectSummary;
  StudioProjectList?: StudioProjectList;
  MediaSequence?: MediaSequence;
  MediaSequenceAudioTrack?: MediaSequenceAudioTrack;
  MediaInfo?: MediaInfo;
  MediaSceneDetection?: MediaSceneDetection;
  StudioRouteId?: StudioRouteId;
  ComponentFolder?: ComponentFolder;
  StudioLibraryItem?: StudioLibraryItem;
  StudioImageShot?: StudioImageShot;
  StudioImageTake?: StudioImageTake;
  StudioReference?: StudioReference;
  StudioTakeReference?: StudioTakeReference;
  StudioPromptSnippet?: StudioPromptSnippet;
  StudioPromptLibrary?: StudioPromptLibrary;
  StudioPluginId?: StudioPluginId;
  StudioPluginRef?: StudioPluginRef;
  StudioPluginLabel?: StudioPluginLabel;
  StudioPluginText?: StudioPluginText;
  StudioPluginForbidPattern?: StudioPluginForbidPattern;
  StudioPluginForbidTerms?: StudioPluginForbidTerms;
  StudioPluginRequirePattern?: StudioPluginRequirePattern;
  StudioPluginRequireTerms?: StudioPluginRequireTerms;
  StudioPluginSubjectCheck?: StudioPluginSubjectCheck;
  StudioPluginShotChecks?: StudioPluginShotChecks;
  StudioPluginRule?: StudioPluginRule;
  StudioPluginPreset?: StudioPluginPreset;
  StudioPluginGenerationRequirement?: StudioPluginGenerationRequirement;
  StudioPluginGeneration?: StudioPluginGeneration;
  StudioPluginCommand?: StudioPluginCommand;
  StudioPluginPanel?: StudioPluginPanel;
  StudioPluginManifest?: StudioPluginManifest;
  StudioPluginIssue?: StudioPluginIssue;
  StudioPluginFile?: StudioPluginFile;
  StudioPluginRuleEntry?: StudioPluginRuleEntry;
  StudioPluginPresetEntry?: StudioPluginPresetEntry;
  StudioPluginGenerationEntry?: StudioPluginGenerationEntry;
  StudioPlugin?: StudioPlugin;
  StudioPluginLimits?: StudioPluginLimits;
  StudioPluginList?: StudioPluginList;
  StudioPluginDetail?: StudioPluginDetail;
  StudioPluginInstallResult?: StudioPluginInstallResult;
  StudioPluginPatch?: StudioPluginPatch;
  StudioPluginProjectUse?: StudioPluginProjectUse;
  StudioPluginRemovalPreview?: StudioPluginRemovalPreview;
  StudioPluginRemoval?: StudioPluginRemoval;
  ControllerPluginsConfig?: ControllerPluginsConfig;
  ComponentMetaPatch?: ComponentMetaPatch;
  MediaClipTitle?: MediaClipTitle;
  MediaClipEffects?: MediaClipEffects;
  MediaClipTransitionSide?: MediaClipTransitionSide;
  MediaClipTransitionCut?: MediaClipTransitionCut;
  PipelineLayoutGroup?: PipelineLayoutGroup;
  PipelineLayout?: PipelineLayout;
  PromptSectionKey?: PromptSectionKey;
  PromptLanguage?: PromptLanguage;
  PromptObservation?: PromptObservation;
  PromptSceneSection?: PromptSceneSection;
  PromptScene?: PromptScene;
  PromptCrop?: PromptCrop;
  PromptCandidate?: PromptCandidate;
  PromptCandidates?: PromptCandidates;
  PromptMetric?: PromptMetric;
  PromptDifference?: PromptDifference;
  PromptComparison?: PromptComparison;
  PromptPairwise?: PromptPairwise;
  PromptVisionAttempt?: PromptVisionAttempt;
  PromptVisionView?: PromptVisionView;
  PromptVisionResult?: PromptVisionResult;
  PromptRubric?: PromptRubric;
  PromptSectionScore?: PromptSectionScore;
  PromptScore?: PromptScore;
  PromptEvaluationRow?: PromptEvaluationRow;
  PromptEvaluationSet?: PromptEvaluationSet;
  PromptRanking?: PromptRanking;
  PromptConfirmation?: PromptConfirmation;
  PromptVersionProvenance?: PromptVersionProvenance;
  PromptStudyVersion?: PromptStudyVersion;
  PromptTaskRequest?: PromptTaskRequest;
  PromptTaskResult?: PromptTaskResult;
  PromptStudyTask?: PromptStudyTask;
  PromptStudySource?: PromptStudySource;
  PromptAcceptance?: PromptAcceptance;
  PromptStudy?: PromptStudy;
  PromptStudySummary?: PromptStudySummary;
  PromptStudyList?: PromptStudyList;
  PromptStudyDeletionPlan?: PromptStudyDeletionPlan;
  WeightLicense?: WeightLicense;
  WeightFileStatus?: WeightFileStatus;
  WeightSetStatus?: WeightSetStatus;
  WeightsDownloadJob?: WeightsDownloadJob;
  WeightsView?: WeightsView;
  WeightsDownloadRequest?: WeightsDownloadRequest;
  TimelineKeyframe?: TimelineKeyframe;
  TimelineMotion?: TimelineMotion;
  TimelineTrack?: TimelineTrack;
  TimelineSource?: TimelineSource;
  TimelineOutputWindow?: TimelineOutputWindow;
  TimelineClip?: TimelineClip;
  TimelineCaption?: TimelineCaption;
  TimelineMarker?: TimelineMarker;
  StudioTimeline?: StudioTimeline;
  TimelineEffect?: TimelineEffect;
  TimelineMask?: TimelineMask;
  MediaClipTitleStyle?: MediaClipTitleStyle;
  TimelineRange?: TimelineRange;
  TimelineCommandAssemble?: TimelineCommandAssemble;
  TimelineCommandPlace?: TimelineCommandPlace;
  TimelineCommandMove?: TimelineCommandMove;
  TimelineCommandTrim?: TimelineCommandTrim;
  TimelineCommandSlip?: TimelineCommandSlip;
  TimelineCommandSlide?: TimelineCommandSlide;
  TimelineCommandSplit?: TimelineCommandSplit;
  TimelineCommandRemove?: TimelineCommandRemove;
  TimelineCommandSetClip?: TimelineCommandSetClip;
  TimelineCommandTransition?: TimelineCommandTransition;
  TimelineCommandAddText?: TimelineCommandAddText;
  TimelineCommandAddAdjustment?: TimelineCommandAddAdjustment;
  TimelineCommandTrack?: TimelineCommandTrack;
  TimelineCommandMarker?: TimelineCommandMarker;
  TimelineCommandCaption?: TimelineCommandCaption;
  TimelineCommandWorkArea?: TimelineCommandWorkArea;
  TimelineCommandMaster?: TimelineCommandMaster;
  TimelineCommandJoin?: TimelineCommandJoin;
  TimelineCommandRearrange?: TimelineCommandRearrange;
  TimelineCommandReconcile?: TimelineCommandReconcile;
  TimelineCommandSetEnabled?: TimelineCommandSetEnabled;
  StudioTimelineCommand?: StudioTimelineCommand;
  StudioTimelineCommandsRequest?: StudioTimelineCommandsRequest;
  StudioTimelineApplied?: StudioTimelineApplied;
  StudioTimelineCommandsResult?: StudioTimelineCommandsResult;
  StudioTimelineRejection?: StudioTimelineRejection;
  StudioTimelineExportRequest?: StudioTimelineExportRequest;
  StudioTimelineExportResult?: StudioTimelineExportResult;
  StudioTakeReviewStatement?: StudioTakeReviewStatement;
  StudioTakeResidueRange?: StudioTakeResidueRange;
  StudioTakeReview?: StudioTakeReview;
  StudioTakeReviews?: StudioTakeReviews;
  StudioTakeReviewsWrite?: StudioTakeReviewsWrite;
  StudioTakeReviewsWriteResult?: StudioTakeReviewsWriteResult;
  CallReceipt?: CallReceipt;
  StudioCreativeEntryWrite?: StudioCreativeEntryWrite;
  StudioCreativeBindingWrite?: StudioCreativeBindingWrite;
  StudioCreativeReference?: StudioCreativeReference;
  StudioCreativeEntrySummary?: StudioCreativeEntrySummary;
  StudioCreativeEntryList?: StudioCreativeEntryList;
  StudioCreativeEntryVersion?: StudioCreativeEntryVersion;
  StudioCreativeBindingVersion?: StudioCreativeBindingVersion;
  StudioCreativeEntryRead?: StudioCreativeEntryRead;
  StudioCreativeBindingRead?: StudioCreativeBindingRead;
  InferenceRecipeExport?: InferenceRecipeExport;
  RecipeComparisonRun?: RecipeComparisonRun;
  RecipeSettingPair?: RecipeSettingPair;
  RecipeMetricPair?: RecipeMetricPair;
  RecipeComparisonStep?: RecipeComparisonStep;
  RecipeComparison?: RecipeComparison;
  StudioCreativeRunPlan?: StudioCreativeRunPlan;
  StudioTakeAttachRequest?: StudioTakeAttachRequest;
  StudioTakeAttachResult?: StudioTakeAttachResult;
  StudioPrevisPose?: StudioPrevisPose;
  StudioPrevisLayer?: StudioPrevisLayer;
  StudioPrevis?: StudioPrevis;
  StudioDraftPlanRequest?: StudioDraftPlanRequest;
  StudioDraftApproval?: StudioDraftApproval;
  StudioDraftSelection?: StudioDraftSelection;
  StudioDraftPlan?: StudioDraftPlan;
  StudioFrozenDraft?: StudioFrozenDraft;
  StudioDraftRunReceipt?: StudioDraftRunReceipt;
  StudioDraftTechnicalReview?: StudioDraftTechnicalReview;
  StudioDraftCandidateResult?: StudioDraftCandidateResult;
  StudioFrozenDraftPlan?: StudioFrozenDraftPlan;
  StudioPrevisCamera3D?: StudioPrevisCamera3D;
  StudioPrevisRig?: StudioPrevisRig;
  StudioDraftPlanList?: StudioDraftPlanList;
  PlacementEnvelope?: PlacementEnvelope;
  PlacementGuard?: PlacementGuard;
  PlacementRequest?: PlacementRequest;
  PlacementNodeResources?: PlacementNodeResources;
  PlacementAlternative?: PlacementAlternative;
  PlacementPreview?: PlacementPreview;
  InferencePresetCapture?: InferencePresetCapture;
  InferencePresetResolve?: InferencePresetResolve;
  InferencePresetSubmit?: InferencePresetSubmit;
  InferencePresetOrigin?: InferencePresetOrigin;
  InferencePresetPolicy?: InferencePresetPolicy;
  InferencePresetList?: InferencePresetList;
  InferencePresetRevision?: InferencePresetRevision;
  InferencePresetPreflight?: InferencePresetPreflight;
  InferencePresetReceipt?: InferencePresetReceipt;
  NativeProviderManifest?: NativeProviderManifest;
  NativeProviderCatalog?: NativeProviderCatalog;
  NativeProviderInfo?: NativeProviderInfo;
  StudioWriteReceipt?: StudioWriteReceipt;
  TimelineCommandRangeCandidate?: TimelineCommandRangeCandidate;
  StudioGapPlanRequest?: StudioGapPlanRequest;
  StudioMediaAdoption?: StudioMediaAdoption;
  StudioMediaTakeAdoptRequest?: StudioMediaTakeAdoptRequest;
  LoraCompatibilityReceipt?: LoraCompatibilityReceipt;
  StudioRetakePlanRequest?: StudioRetakePlanRequest;
  TimelineCommandCollectOutput?: TimelineCommandCollectOutput;
  StudioCreativeMediaBindings?: StudioCreativeMediaBindings;
  StudioRenderSubmissionRequest?: StudioRenderSubmissionRequest;
  StudioDraftBranchPlanRequest?: StudioDraftBranchPlanRequest;
  StudioSeamPlanRequest?: StudioSeamPlanRequest;
  StudioOtioEditsRequest?: StudioOtioEditsRequest;
  StudioOtioReferencePlanRequest?: StudioOtioReferencePlanRequest;
  StudioWorkOrigin?: StudioWorkOrigin;
  StudioPortableReport?: StudioPortableReport;
  StudioPortableImport?: StudioPortableImport;
  StudioPortableHistory?: StudioPortableHistory;
  LoadPolicy?: LoadPolicy1;
  RunStepComponentLoad?: RunStepComponentLoad;
  StorageCategory?: StorageCategory;
  StorageFileKey?: StorageFileKey;
  StorageTotal?: StorageTotal;
  StorageTotals?: StorageTotals;
  StorageCleanOptions?: StorageCleanOptions;
  StorageScope?: StorageScope;
  StorageCleanRequest?: StorageCleanRequest;
  StorageItem?: StorageItem;
  StorageNodeState?: StorageNodeState;
  StorageCleanResult?: StorageCleanResult;
  StorageUsage?: StorageUsage;
  StoragePin?: StoragePin;
  StoragePins?: StoragePins;
  StoragePinsRequest?: StoragePinsRequest;
  NodeStorageInventory?: NodeStorageInventory;
  NodeStorageCleanRequest?: NodeStorageCleanRequest;
  NodeStorageCleanResult?: NodeStorageCleanResult;
  StorageWork?: StorageWork;
  LoraTrainingSource?: LoraTrainingSource;
  LoraTrainingRoute?: LoraTrainingRoute;
  LoraTrainingEvalPrompt?: LoraTrainingEvalPrompt;
  LoraTrainingOptions?: LoraTrainingOptions;
  LoraTrainingRequest?: LoraTrainingRequest;
  LoraTrainingAction?: LoraTrainingAction;
  LoraTrainingClipEdit?: LoraTrainingClipEdit;
  LoraTrainingSummary?: LoraTrainingSummary;
  LoraTraining?: LoraTraining;
  LoraTrainingList?: LoraTrainingList;
  LocalImportRequest?: LocalImportRequest;
  LocalImportListing?: LocalImportListing;
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "ApiErrorBody".
 */
export interface ApiErrorBody {
  code: string;
  message: string;
  details?: {
    [k: string]: unknown | undefined;
  };
  remote_outcome_unknown?: boolean;
}
/**
 * x-phasyn-extension：409 EXCLUSIVE_GROUP_BUSY／EXCLUSIVE_GROUP_CONFLICT 的 Error.details：目標所屬的互斥群組，與同 Node 上目前佔用該群組（loading 或已載入）的成員。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "ExclusiveGroupDetails".
 */
export interface ExclusiveGroupDetails {
  group: string;
  holders: {
    component_id: string;
    state: ComponentState;
    active_call_id: string | null;
  }[];
  [k: string]: unknown | undefined;
}
/**
 * x-phasyn-extension：一組 (node_id, device_id, component_id, load_digest, source_revision) 的成本檔案，由主控從本機 recordings 的 cost 區塊擬合（不內建任何量測數字）。warm_samples == 0 且 cold_samples > 0 表示冷擬合：overhead 含冷啟動，數值偏高。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "CostProfile".
 */
export interface CostProfile {
  node_id: string;
  device_id: string | null;
  component_id: string;
  provider_id: string;
  load_digest: string | null;
  source_revision: string | null;
  /**
   * 載入時間的中位數；沒有載入紀錄時 null
   */
  load_ms: number | null;
  load_samples: number;
  /**
   * wall − Σcompute − 傳輸（下限 0）
   */
  overhead_ms: number | null;
  /**
   * 載入後第一次呼叫比暖機呼叫多花的時間；未知為 null
   */
  cold_ms: number | null;
  /**
   * θ 實際用的樣本數：有暖機樣本時＝warm_samples，沒有時＝cold_samples
   */
  samples: number;
  /**
   * 擬合窗內（30 天、最新 50 筆）成功 invoke 中 warm=true 的筆數
   */
  warm_samples: number;
  /**
   * 擬合窗內（30 天、最新 50 筆）成功 invoke 中 warm=false 的筆數
   */
  cold_samples: number;
  updated_at: string | null;
  last_recording_id: string | null;
  stages: CostProfileStage[];
}
/**
 * x-phasyn-extension：一個 stage 的成本擬合：每單位運算量的毫秒數與它的依據。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "CostProfileStage".
 */
export interface CostProfileStage {
  stage: string;
  work_unit: "flop" | "pixel" | "pixel_frame" | "second" | "byte" | "token" | "call";
  /**
   * 每單位 work 的毫秒數（擬合值）
   */
  theta_ms_per_unit: number;
  samples: number;
  /**
   * log 殘差 10 分位；samples < 2 時 null
   */
  residual_q10: number | null;
  /**
   * log 殘差 90 分位；samples < 2 時 null
   */
  residual_q90: number | null;
  /**
   * 成功過的最大 risk_measure（stage 沒有 risk_measure 時為 null）
   */
  max_succeeded_risk: number | null;
  /**
   * 因 GPU_OOM／HOST_OOM 失敗的最小 risk_measure；之後有同樣大小或更大的呼叫成功的失敗不算（OOM 預警用；沒有 risk_measure 時為 null）
   */
  min_failed_risk: number | null;
  /**
   * risk_measure 的單位（例如 row）；沒有 risk_measure 時為 null
   */
  risk_unit: string | null;
  updated_at: string;
  last_recording_id: string;
}
/**
 * x-phasyn-extension：GET /api/cost-profiles 的回應。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "CostProfileList".
 */
export interface CostProfileList {
  computed_at: string;
  items: CostProfile[];
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "Device".
 */
export interface Device {
  kind: "cpu" | "cuda";
  id: string;
  resource_group: string;
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "RecorderConfig".
 */
export interface RecorderConfig {
  mode: "off" | "summary" | "detailed" | "trace";
  device_sample_hz?: number;
  publish_interval_ms?: number;
  batch_max_events?: number;
  batch_max_bytes?: number;
  queue_max_events?: number;
  queue_max_bytes?: number;
  segment_bytes?: number;
  max_detail_bytes_per_recording?: number;
  cuda_pending_event_pairs?: number;
  trace_steps?: number[];
  trace_parts?: string[];
  record_shapes?: boolean;
  with_stack?: boolean;
  capture_prompt?: boolean;
  tensor_dump?: boolean;
  capture_stderr?: boolean;
  finite_scan?: boolean;
  gpu_event_timing?: boolean;
  log_level?: "debug" | "info" | "warning" | "error";
  parts?: string[];
  steps?: number[];
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "Precision".
 */
export interface Precision {
  weight_format?: string;
  weight_dtype?: string;
  compute_dtype?: string;
  autocast_dtype?: string | null;
  accumulation_dtype?: string | null;
  matmul_tf32?: boolean | null;
  cudnn_tf32?: boolean | null;
  reduced_precision_reduction?: boolean | null;
  output_dtype?: string;
  quantization?: {
    [k: string]: unknown | undefined;
  };
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "PartOverride".
 */
export interface PartOverride {
  selector: string;
  settings: {
    [k: string]: unknown | undefined;
  };
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "LoadSettings".
 */
export interface LoadSettings {
  model_path?: string;
  model_revision?: string | null;
  device: Device;
  precision?: Precision;
  offload?: {
    [k: string]: unknown | undefined;
  };
  part_overrides?: PartOverride[];
  provider_options?: {
    [k: string]: unknown | undefined;
  };
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "InstanceSettings".
 */
export interface InstanceSettings {
  load: LoadSettings;
  invoke: {
    [k: string]: unknown | undefined;
  };
  recording: RecorderConfig;
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "InstanceDefinition".
 */
export interface InstanceDefinition {
  component_id: string;
  label: string;
  provider_id: string;
  settings: InstanceSettings;
  runtime_id: string;
  autostart?: boolean;
  load_policy?: LoadPolicy;
  /**
   * x-phasyn-extension：load_policy=on_demand 時，閒置多少秒後自動卸載；沒有設定＝600 秒。resident 元件忽略此值。
   */
  idle_unload_seconds?: number;
  folder?: ComponentFolder | null;
  /**
   * x-phasyn-extension：互斥群組。同一 Node 上同群組的元件一次只能有一個處於 loading 或已載入（例如 DiT 需要大量主記憶體）；由 Node 在 start／restart 時強制（409 EXCLUSIVE_GROUP_BUSY／EXCLUSIVE_GROUP_CONFLICT）。
   */
  exclusive_group?: string;
  /**
   * x-phasyn-extension：元件的使用上限（資料驅動）。schema 只規定是 object，內容由使用端定義（例如 limits.swap，見 docs/）；序列化後 ≤ 16 KiB，由 Node 檢查。
   */
  limits?: {
    [k: string]: unknown | undefined;
  };
  /**
   * The owner declares that replacing a verified stopped attempt is safe for this component. Absent means no replacement.
   */
  retry_after_verified_stop?: boolean;
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "SettingsPatch".
 */
export interface SettingsPatch {
  expected_revision?: number;
  patch: {
    [k: string]: unknown | undefined;
  };
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "SettingsView".
 */
export interface SettingsView {
  stored_revision: number;
  loaded_revision: number | null;
  stored: InstanceSettings;
  loaded: LoadSettings | null;
  restart_required: boolean;
  settings_schema: {
    [k: string]: unknown | undefined;
  };
  parameters_schema: {
    [k: string]: unknown | undefined;
  };
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "Part".
 */
export interface Part {
  path: string;
  kind: string;
  settings_schema: {
    [k: string]: unknown | undefined;
  };
  observable: string[];
  coverage: "full" | "partial" | "none";
  reason: string | null;
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "Port".
 */
export interface Port {
  name: string;
  type_id: string;
  required: boolean;
  transport: "inline" | "file" | "either";
  description: string;
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "ComponentDescriptor".
 */
export interface ComponentDescriptor {
  component_id: string;
  label: string;
  provider_id: string;
  runtime_id: string;
  node_id: string;
  state: ComponentState;
  device: Device;
  api_path: string;
  inputs: Port[];
  outputs: Port[];
  parts: Part[];
  settings: SettingsView;
  active_call_id: string | null;
  last_error: ApiErrorBody | null;
  recorder_state: "ok" | "degraded" | "off" | "unknown";
  /**
   * x-phasyn-extension：介面分類資料夾（null＝未分類，介面依 provider 類別顯示）
   */
  folder: ComponentFolder | null;
  /**
   * x-phasyn-extension：Node 服務啟動時是否自動啟動
   */
  autostart: boolean;
  load_policy?: LoadPolicy1;
  /**
   * x-phasyn-extension：元件定義的閒置卸載秒數；沒有設定＝null（on_demand 時主控用 600 秒）
   */
  idle_unload_seconds?: number | null;
  /**
   * x-phasyn-extension：元件定義的互斥群組；沒有設定＝null（Node 一律輸出）
   */
  exclusive_group: string | null;
  /**
   * x-phasyn-extension：元件定義的使用上限；沒有設定＝null（Node 一律輸出）
   */
  limits: {
    [k: string]: unknown | undefined;
  } | null;
  /**
   * x-phasyn-extension：provider describe 回報的事實（任意 JSON，序列化後 ≤ 16 KiB；例如 facts.cost_model）；沒有或不可用時為 null（Lite 目錄不帶）
   */
  facts: {
    [k: string]: unknown | undefined;
  } | null;
  /**
   * The owner declares that replacing a verified stopped attempt is safe for this component. Absent means no replacement.
   */
  retry_after_verified_stop?: boolean;
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "NodeSnapshot".
 */
export interface NodeSnapshot {
  node_id: string;
  process_instance_id: string;
  label: string;
  endpoint: Endpoint;
  protocol_version: "4.0";
  platform: string;
  components: ComponentDescriptor[];
  observed_at: string;
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "DirectoryEntry".
 */
export interface DirectoryEntry {
  node_id: string;
  label: string;
  endpoint: Endpoint;
  state: "online" | "offline" | "duplicate_node_id";
  last_seen_at: string;
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "RegistrationAck".
 */
export interface RegistrationAck {
  registered: boolean;
  nodes: DirectoryEntry[];
  controller_endpoint: Endpoint;
  controller_id: string;
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "Catalog".
 */
export interface Catalog {
  nodes: NodeSnapshot[];
  directory: DirectoryEntry[];
  observed_at: string;
}
/**
 * x-phasyn-extension：GET /api/catalog?parts=false 的回應（前端每 3 秒輪詢用）：與 Catalog 相同，但元件不含 parts（約佔完整目錄 85% 的大小），改附 parts_count 與 parts_digest；需要 parts 時讀完整目錄。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "CatalogLite".
 */
export interface CatalogLite {
  nodes: NodeSnapshotLite[];
  directory: DirectoryEntry[];
  observed_at: string;
}
/**
 * x-phasyn-extension：NodeSnapshot，但 components 是 ComponentDescriptorLite（不含 parts）。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "NodeSnapshotLite".
 */
export interface NodeSnapshotLite {
  node_id: string;
  process_instance_id: string;
  label: string;
  endpoint: Endpoint;
  protocol_version: "4.0";
  platform: string;
  components: ComponentDescriptorLite[];
  observed_at: string;
}
/**
 * x-phasyn-extension：ComponentDescriptor 去掉 parts（改附 parts_count 與 parts_digest），其他欄位相同；GET /api/catalog?parts=false 用。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "ComponentDescriptorLite".
 */
export interface ComponentDescriptorLite {
  component_id: string;
  label: string;
  provider_id: string;
  runtime_id: string;
  node_id: string;
  state: ComponentState;
  device: Device;
  api_path: string;
  inputs: Port[];
  outputs: Port[];
  /**
   * parts 的筆數（parts 本身不在這個回應裡）
   */
  parts_count: number;
  /**
   * parts 的 SHA-256（canonical JSON）：與上次讀到的不同時，用完整目錄（GET /api/catalog）重新讀 parts
   */
  parts_digest: string;
  /**
   * 完整描述 facts 的 SHA-256（canonical JSON：鍵排序、不含空白、UTF-8、不允許 NaN，與 parts_digest 同一套規則）；facts 為 null 時為 null。與上次讀到的不同時，用完整目錄（GET /api/catalog）重新讀 facts
   */
  facts_digest: string | null;
  settings: SettingsView;
  active_call_id: string | null;
  last_error: ApiErrorBody | null;
  recorder_state: "ok" | "degraded" | "off" | "unknown";
  /**
   * x-phasyn-extension：介面分類資料夾（null＝未分類，介面依 provider 類別顯示）
   */
  folder: ComponentFolder | null;
  /**
   * x-phasyn-extension：Node 服務啟動時是否自動啟動
   */
  autostart: boolean;
  load_policy?: LoadPolicy1;
  /**
   * x-phasyn-extension：元件定義的閒置卸載秒數；沒有設定＝null（on_demand 時主控用 600 秒）
   */
  idle_unload_seconds?: number | null;
  /**
   * x-phasyn-extension：元件定義的互斥群組；沒有設定＝null（Node 一律輸出）
   */
  exclusive_group: string | null;
  /**
   * x-phasyn-extension：元件定義的使用上限；沒有設定＝null（Node 一律輸出）
   */
  limits: {
    [k: string]: unknown | undefined;
  } | null;
  /**
   * The owner declares that replacing a verified stopped attempt is safe for this component. Absent means no replacement.
   */
  retry_after_verified_stop?: boolean;
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "FileRef".
 */
export interface FileRef {
  node_id: string;
  file_id: string;
  size_bytes: number;
  sha256: string;
  media_type: string;
  metadata: {
    [k: string]: unknown | undefined;
  };
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "Step".
 */
export interface Step {
  step_id: string;
  node_id: string;
  component_id: string;
  inputs: {
    [k: string]: Binding | undefined;
  };
  parameters: {
    [k: string]: unknown | undefined;
  };
  load_revision?: number | null;
  recording_override?: RecorderConfig;
  timeout_seconds?: number;
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "Pipeline".
 */
export interface Pipeline {
  pipeline_id: string;
  label: string;
  inputs: Port[];
  /**
   * @minItems 1
   * @maxItems 256
   */
  steps: Step[];
  outputs: {
    [k: string]:
      | {
          from_step: string;
          output: string;
        }
      | undefined;
  };
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "Origin".
 */
export interface Origin {
  source_run_id?: string;
  preview_asset_id?: string;
  note?: string;
  inference_preset?: InferencePresetOrigin;
  studio_work?: StudioWorkOrigin;
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "InferencePresetOrigin".
 */
export interface InferencePresetOrigin {
  preset_id: string;
  revision: number;
  definition_sha256: string;
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioWorkOrigin".
 */
export interface StudioWorkOrigin {
  project_id: string;
  operation_kind:
    | "draft_branch"
    | "mask"
    | "audio_mix"
    | "animatic"
    | "seam"
    | "export"
    | "reference"
    | "render"
    | "retake"
    | "draft";
  shot_id?: string;
  source_digest?: string;
  recipe_digest?: string;
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "RunRequest".
 */
export interface RunRequest {
  pipeline: Pipeline;
  inputs: {
    [k: string]: TypedValue | undefined;
  };
  label?: string;
  origin?: Origin;
  /**
   * x-phasyn-extension: proxy = a small CPU rendition of a timeline source (one media.concat step); it does not take one of the Controller's max_active_runs slots.
   */
  purpose?: "proxy";
  /**
   * A retry_verified step permits one replacement after a durable receipt proves the previous attempt stopped with missing outputs or was rejected before starting.
   */
  recovery_policy?: "retry_verified" | "observe_only";
  placement?: PlacementGuard;
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "PlacementGuard".
 */
export interface PlacementGuard {
  signature: string;
  envelope: PlacementEnvelope;
  claims: {
    [k: string]: number | undefined;
  };
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "PlacementEnvelope".
 */
export interface PlacementEnvelope {
  signature: string;
  basis: string;
  nodes: {
    [k: string]:
      | {
          host_bytes: number;
          device_bytes: {
            [k: string]: number | undefined;
          };
        }
      | undefined;
  };
  stage_risks?: {
    [k: string]:
      | {
          [k: string]:
            | {
                unit: string;
                value: number;
              }
            | undefined;
        }
      | undefined;
  };
  evidence?: {
    run_id: string;
    /**
     * @minItems 1
     * @maxItems 32
     */
    recording_ids: string[];
    padding_percent: number;
  };
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "InvokeRequest".
 */
export interface InvokeRequest {
  call_id: string;
  run_id: string | null;
  step_id: string | null;
  inputs: {
    [k: string]: TypedValue | undefined;
  };
  parameters: {
    [k: string]: unknown | undefined;
  };
  required_loaded_revision: number | null;
  recording: RecorderConfig;
  timeout_seconds: number;
  retry_of?: {
    call_id: string;
    request_digest: string;
  };
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "EffectiveContext".
 */
export interface EffectiveContext {
  requested: {
    [k: string]: unknown | undefined;
  };
  effective: {
    [k: string]: unknown | undefined;
  };
  observed: {
    [k: string]: unknown | undefined;
  };
  stored_revision: number;
  loaded_revision: number | null;
  expanded_parts: {
    [k: string]:
      | {
          [k: string]: unknown | undefined;
        }
      | undefined;
  };
  config_digest: string;
  model_identity: {
    [k: string]: unknown | undefined;
  };
  runtime_identity: {
    [k: string]: unknown | undefined;
  };
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "InvokeResult".
 */
export interface InvokeResult {
  call_id: string;
  recording_id: string;
  state: "succeeded" | "failed" | "cancelled";
  outputs: {
    [k: string]: TypedValue | undefined;
  };
  settings: EffectiveContext;
  error: ApiErrorBody | null;
  summary: RecordingSummary | FileRef;
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "RecordingSummary".
 */
export interface RecordingSummary {
  recording_id: string;
  state: "running" | "succeeded" | "failed" | "cancelled" | "interrupted" | "unknown";
  metrics: {
    [k: string]: Metric | undefined;
  };
  transfer_totals: {
    [k: string]:
      | {
          [k: string]: unknown | undefined;
        }
      | undefined;
  };
  part_totals: {
    [k: string]:
      | {
          [k: string]: unknown | undefined;
        }
      | undefined;
  };
  coverage: "full" | "partial" | "none";
  dropped_events: number;
  dropped_bytes: number;
  detail_truncated: boolean;
  notes: string[];
  context_available: boolean;
  cost?: RecordingCost;
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "Metric".
 */
export interface Metric {
  value: number | null;
  unit: string;
  quality: Quality;
  scope: string;
  method: string;
  reason: string | null;
  count?: number;
}
/**
 * x-phasyn-extension：這次呼叫（或載入）實際做了多少運算，給耗時估計器擬合成本檔案用（不是預測）。load_digest、warm、loadavg、device_id、source_revision 由元件程序通用填寫；stages 由 provider 以 Recorder.record_cost() 記錄。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "RecordingCost".
 */
export interface RecordingCost {
  /**
   * 生效 load 設定的 canonical SHA-256（同一份載入設定才可互相比較）
   */
  load_digest: string | null;
  /**
   * true＝載入後不是第一次呼叫；false＝載入後第一次；null＝不適用（load 紀錄）
   */
  warm: boolean | null;
  /**
   * 呼叫開始與結束時主機的 1 分鐘平均負載（取不到為 null）
   */
  loadavg: {
    start: number | null;
    end: number | null;
  } | null;
  device_id: string | null;
  source_revision: string | null;
  /**
   * @maxItems 64
   */
  stages: RecordingCostStage[];
  /**
   * 超過 64 個 stage 時未記錄的筆數
   */
  dropped_stages?: number;
}
/**
 * x-phasyn-extension：一個 stage 的實際運算量。work 以 work_unit 計；compute_ms 是該 stage 量到的運算時間；shape 是推得 work 的純量事實（例如 seq_len、steps）。shape 保留兩個鍵：risk_measure（隨記憶體用量增長的數，例如 DiT 的 used rows）與 risk_unit（它的單位，例如 row），供 OOM 預警比較。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "RecordingCostStage".
 */
export interface RecordingCostStage {
  stage: string;
  work: number;
  work_unit: "flop" | "pixel" | "pixel_frame" | "second" | "byte" | "token" | "call";
  compute_ms: number | null;
  shape: {
    [k: string]: number | string | boolean | null | undefined;
  };
}
export interface Run1 {
  studio_work?: StudioWorkOrigin;
  run_id: string;
  state: "running" | "succeeded" | "failed" | "cancelled" | "interrupted";
  request: RunRequest;
  created_at: string;
  finished_at: string | null;
  /**
   * 步驟 id → RunStepState（執行中的步驟可帶 preview，x-phasyn-extension）
   */
  steps: {
    [k: string]: RunStepState | undefined;
  };
  outputs: {
    [k: string]: TypedValue | undefined;
  };
  recording_ids: string[];
  error: ApiErrorBody | null;
  /**
   * x-phasyn-extension：封存時間（POST /api/runs/{run_id}/archive）。沒有此欄位或 null＝未封存；封存只影響 GET /api/runs 的預設篩選，不刪除任何東西。
   */
  archived_at?: string | null;
  recovery_version?: 1;
  stop_reason?: "user" | "cancelled" | "failure";
  stop_step?: string | null;
  /**
   * Controller-owned UTC epoch deadline. A draft plan may not start additional Node calls after this time.
   */
  dispatch_deadline?: number;
}
/**
 * Run.steps[step_id]：一個步驟的狀態物件（runner 寫入 state、node_id、component_id、call_id、recording_id、started_at、finished_at、outputs、error、remote_outcome_unknown、settings、load_revision、invoke_snapshot、recording_snapshot）。x-phasyn-extension：running 的步驟可另帶 preview（RunStepPreview）；preview 只在主控記憶體，不寫進 run.json，步驟結束即消失。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "RunStepState".
 */
export interface RunStepState {
  preview?: RunStepPreview;
  resource_group?: string;
  /**
   * @maxItems 2
   */
  attempts?: {
    call_id: string;
    request_digest: string;
    cancel_sent: boolean;
    superseded?: boolean;
  }[];
  /**
   * The owner declares that replacing a verified stopped attempt is safe for this component. Absent means no replacement.
   */
  retry_after_verified_stop?: boolean;
  /**
   * The Controller is querying the recorded attempt on its original Node.
   */
  awaiting_receipt?: boolean;
  lora_compatibility?: LoraCompatibilityReceipt;
  component_load?: RunStepComponentLoad;
  [k: string]: unknown | undefined;
}
/**
 * x-phasyn-extension：執行中步驟最新的一張中間預覽（非最終結果；介面標示「預覽（非最終結果）」）。由元件在一次 invoke 內以 publish_preview 發布；Node 只保留該呼叫最新的一張、呼叫結束即刪除，所以步驟結束後就沒有 preview，最終輸出才是結果。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "RunStepPreview".
 */
export interface RunStepPreview {
  /**
   * 這次呼叫內的預覽序號（由 1 遞增；送出前就被更新預覽取代的會跳號）
   */
  seq: number;
  /**
   * provider 回報的進度（例如已完成的去噪步數；0 ≤ step ≤ total）
   */
  step: number;
  /**
   * 進度的總數（例如總去噪步數）
   */
  total: number;
  /**
   * 影像寬（px，與影像標頭一致）
   */
  width: number;
  /**
   * 影像高（px，與影像標頭一致）
   */
  height: number;
  media_type: "image/jpeg" | "image/png";
  /**
   * 影像 bytes（上限 2 MiB）
   */
  size_bytes: number;
  /**
   * provider 對這張預覽的說明（例如預覽方式）；沒有 → null
   */
  note: string | null;
  /**
   * Node 收到這張預覽的時間（UTC）
   */
  at: string;
  /**
   * 主控相對路徑（GET /api/runs/{run_id}/steps/{step_id}/preview?seq=）：回影像 bytes，Content-Type＝media_type、Cache-Control: no-store；seq 只用來避開瀏覽器快取，回的永遠是 Node 當下最新的一張；步驟已結束 → 404 PREVIEW_NOT_FOUND。
   */
  url: string;
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "LoraCompatibilityReceipt".
 */
export interface LoraCompatibilityReceipt {
  version: 1;
  revision: string;
  definition_sha256: string;
  load_source: "loaded" | "stored";
  load_revision: number;
  adapters: {
    rule_id: string | null;
    role?: "style" | "control" | "acceleration";
    declared_weight_revision?: string;
    declared_weight_sha256?: string;
    configured_weight_sha256_matched?: true;
  }[];
}
/**
 * x-phasyn-extension：步驟要用的 on_demand 元件尚未載入時，主控正在為它做什麼。phase=loading（步驟 state=running）＝主控已送出 start、正在等元件 ready；phase=waiting（步驟 state=waiting）＝暫時不能載入（reason 說明原因），主控每隔幾秒重新檢查，不是失敗。呼叫送出後此欄位消失。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "RunStepComponentLoad".
 */
export interface RunStepComponentLoad {
  phase: "loading" | "waiting";
  /**
   * loading＝模型載入中；exclusive_busy＝互斥群組的其他成員正在載入、停止或執行呼叫；exclusive_resident＝互斥群組已由 resident 元件載入（主控不會替換它，需要人停止它）；exclusive_reserved＝互斥群組的已載入成員還有排隊中的步驟要用；device_busy＝同一 resource_group 正被其他工作使用；stopping＝元件正在停止（例如閒置卸載），停好後會重新載入。
   */
  reason: "loading" | "exclusive_busy" | "exclusive_resident" | "exclusive_reserved" | "device_busy" | "stopping";
  message: string;
  component_id: string;
  /**
   * 擋住載入的互斥群組成員（component_id）；沒有＝空陣列
   *
   * @maxItems 64
   */
  holders: string[];
  since: string;
  /**
   * 依這個元件過去的載入紀錄估計的載入時間（成本模型 load_ms 中位數）；沒有紀錄＝null
   */
  estimated_load_ms: number | null;
}
/**
 * x-phasyn-extension：Node → 主控「步驟有新的中間預覽」（POST /api/runs/{run_id}/steps/{step_id}/preview）。只有中繼資料、不含影像；best-effort：每個呼叫同時最多一個通知、永遠送最新一張，失敗不重送。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "RunStepPreviewNotice".
 */
export interface RunStepPreviewNotice {
  node_id: string;
  component_id: string;
  call_id: string;
  /**
   * 這次呼叫內的預覽序號（由 1 遞增；送出前就被更新預覽取代的會跳號）
   */
  seq: number;
  /**
   * provider 回報的進度（例如已完成的去噪步數；0 ≤ step ≤ total）
   */
  step: number;
  /**
   * 進度的總數（例如總去噪步數）
   */
  total: number;
  /**
   * 影像寬（px，與影像標頭一致）
   */
  width: number;
  /**
   * 影像高（px，與影像標頭一致）
   */
  height: number;
  media_type: "image/jpeg" | "image/png";
  /**
   * 影像 bytes（上限 2 MiB）
   */
  size_bytes: number;
  /**
   * provider 對這張預覽的說明（例如預覽方式）；沒有 → null
   */
  note: string | null;
  /**
   * Node 收到這張預覽的時間（UTC）
   */
  at: string;
}
/**
 * x-phasyn-extension：預覽通知的回覆。accepted=false＝已忽略（run 不在執行中、步驟不是 running、node／component／call_id 不符或已有較新的 seq），不是錯誤。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "RunStepPreviewAck".
 */
export interface RunStepPreviewAck {
  accepted: boolean;
  message: string;
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "ControlRequest".
 */
export interface ControlRequest {
  action: "start" | "stop" | "restart";
  /**
   * x-phasyn-extension：只對 start／restart 有意義。目標元件有 exclusive_group，且同 Node 同群組的其他成員都已載入但閒置時，true＝Node 先依序停止它們（同一把鎖內、記錄在事件裡）再載入目標；false（預設）＝回 409 EXCLUSIVE_GROUP_CONFLICT。成員正在 loading 或有進行中的呼叫時一律回 409 EXCLUSIVE_GROUP_BUSY；停止失敗就回錯誤、不載入。
   */
  replace_exclusive?: boolean;
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "CancelRequest".
 */
export interface CancelRequest {
  call_id: string;
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "CancelResult".
 */
export interface CancelResult {
  call_id: string | null;
  accepted: boolean;
  process_exited: boolean | null;
  message: string;
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "RecordingContext".
 */
export interface RecordingContext {
  recording_id: string;
  node_id: string;
  component_id: string;
  provider_id: string;
  process_instance_id: string;
  run_id: string | null;
  call_id: string | null;
  operation: "load" | "invoke" | "unload" | "controller" | "node";
  created_at: string;
  clock_domain: string;
  settings: EffectiveContext | null;
  input_summary: {
    [k: string]: unknown | undefined;
  };
  recording: RecorderConfig;
  environment: {
    [k: string]: unknown | undefined;
  };
  synthetic: boolean;
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "SpanData".
 */
export interface SpanData {
  span_id: string;
  parent_span_id: string | null;
  name: string;
  part: string | null;
  step_index: number | null;
  clock_domain: string;
  start_mono_ns: string;
  end_mono_ns: string;
  host_ms: number;
  gpu_event_ms: number | null;
  gpu_device_id: string | null;
  gpu_stream_id: string | null;
  quality: Quality;
  coverage: "full" | "partial" | "none";
  reason: string | null;
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "TransferData".
 */
export interface TransferData {
  transfer_id: string;
  category:
    | "weight_h2d"
    | "weight_d2h"
    | "activation_h2d"
    | "activation_d2h"
    | "device_copy"
    | "peer_copy"
    | "host_copy"
    | "pin"
    | "unpin"
    | "disk_read"
    | "disk_write"
    | "network"
    | "diagnostic_readback";
  part: string | null;
  step_index: number | null;
  forward_index: number | null;
  offload_cycle_id: string | null;
  roundtrip_id: string | null;
  direction: "H2D" | "D2H" | "D2D" | "H2H" | "NET" | "DISK_IN" | "DISK_OUT" | "NONE";
  submitted_count: number;
  submitted_bytes: number;
  completed_count: number | null;
  completed_bytes: number | null;
  host_ms: number;
  gpu_event_ms: number | null;
  clock_domain: string;
  owner: "consumer" | "producer" | "runtime";
  byte_basis: "logical_tensor" | "packed_payload" | "http_entity" | "logical_file" | "trace_memcpy";
  quality: Quality;
  actual_copy: boolean;
  reason: string | null;
  src: string;
  dst: string;
  src_memory_kind: string;
  dst_memory_kind: string;
  logical_bytes: number;
  host_submit_ms: number;
  completion_status: "submitted" | "completed" | "unknown" | "failed" | "no_op";
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "SampleData".
 */
export interface SampleData {
  sample_id: string;
  device_id: string | null;
  process_id: number | null;
  metrics: {
    [k: string]: Metric | undefined;
  };
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StepData".
 */
export interface StepData {
  step_index: number;
  scheduler_update_index: number | null;
  forward_index: number | null;
  cfg_branch: string | null;
  sigma: number | null;
  host_ms: number;
  gpu_event_ms: number | null;
  metrics: {
    [k: string]: Metric | undefined;
  };
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "LogData".
 */
export interface LogData {
  message: string;
  fields: {
    [k: string]: unknown | undefined;
  };
  truncated: boolean;
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "RecorderNotice".
 */
export interface RecorderNotice {
  code: string;
  message: string;
  dropped_events: number;
  dropped_bytes: number;
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "Recording".
 */
export interface Recording {
  context: RecordingContext;
  summary: RecordingSummary;
  /**
   * x-phasyn-extension：主控 GET /api/recordings/{recording_id} 附上這筆 recording 已收到的 event stream（依 stream_id 排序）；前端不必為了知道 stream 名稱而觸發 400 AMBIGUOUS_STREAM。Node 與列表（RecordingPage）不附。
   */
  streams?: RecordingStream[];
}
/**
 * x-phasyn-extension：recording 已收到的一個 event stream（主控副本）。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "RecordingStream".
 */
export interface RecordingStream {
  stream_id: string;
  last_seq: number;
  event_count: number;
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "EventBatch".
 */
export interface EventBatch {
  node_id: string;
  /**
   * @maxItems 64
   */
  contexts: RecordingContext[];
  /**
   * @maxItems 4096
   */
  events: RecordingEvent[];
  /**
   * @maxItems 64
   */
  summaries: RecordingSummary[];
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "BatchAck".
 */
export interface BatchAck {
  accepted_events: number;
  duplicate_events: number;
  rejected_events: number;
  message: string;
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "EventPage".
 */
export interface EventPage {
  events: RecordingEvent[];
  next_seq: number | null;
  stream_id: string;
  has_more: boolean;
  gap: boolean;
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "RecordingPage".
 */
export interface RecordingPage {
  items: Recording[];
  next_cursor: string | null;
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "Comparison".
 */
export interface Comparison {
  /**
   * @minItems 2
   * @maxItems 8
   */
  recording_ids: string[];
  settings_diff: {
    [k: string]: unknown | undefined;
  }[];
  metrics: {
    [k: string]: Metric[] | undefined;
  };
  confounders: string[];
  same_source: boolean | null;
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "FetchHistoryRequest".
 */
export interface FetchHistoryRequest {
  node_id: string;
  stream_id?: string | null;
  after_seq?: number;
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "FetchHistoryResult".
 */
export interface FetchHistoryResult {
  recording_id: string;
  imported_events: number;
  still_partial: boolean;
  message: string;
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "ControllerConfig".
 */
export interface ControllerConfig {
  instance_id: string;
  label: string;
  bind_host: string;
  port: number;
  advertise_url: Endpoint;
  data_dir: string;
  static_dir: string;
  max_active_runs: number;
  node_stale_seconds: number;
  /**
   * x-phasyn-extension：JSON request body 的上限（bytes）；超過回 413 PAYLOAD_TOO_LARGE
   */
  max_json_body_bytes?: number;
  /**
   * x-phasyn-extension：單一上傳檔的上限（bytes，邊收邊計數）；超過回 413 PAYLOAD_TOO_LARGE
   */
  max_upload_bytes?: number;
  /**
   * x-phasyn-extension：允許的 Host 標頭（主機名稱或 IP，不含 port，比對不分大小寫；IPv6 可寫 [::1] 或 ::1）。設定後只接受清單內的 Host，其他一律回 400 HOST_NOT_ALLOWED（防 DNS rebinding）；不設＝只接受 IP 位址、localhost、本機主機名稱、advertise_url 的主機與 bind_host；空陣列不允許（會擋掉所有請求，包含 Node 上報與轉送）。
   *
   * @minItems 1
   */
  allowed_hosts?: string[];
  plugins?: ControllerPluginsConfig;
  recording: RecorderConfig;
  /**
   * x-phasyn-extension：Controller 本機上可以挑選影片匯入的資料夾（LoRA 訓練的「從伺服器選擇」）；沒有設定＝不開放
   *
   * @maxItems 16
   */
  import_roots?: string[];
}
/**
 * x-phasyn-extension：主控設定檔的插件區塊（只能在設定檔修改，API 無法變更）。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "ControllerPluginsConfig".
 */
export interface ControllerPluginsConfig {
  /**
   * api＝連得到主控的用戶端可以安裝與移除插件包（與其他 API 一樣沒有驗證；權限限制的是插件程式碼，不是人）；disabled＝API 不接受安裝與移除（409 STUDIO_PLUGIN_INSTALL_DISABLED），內建包與 dev_dirs 仍然載入。
   */
  install?: "api" | "disabled";
  /**
   * 開發中的插件包目錄（絕對路徑，或相對於設定檔所在目錄；每個目錄的根有 plugin.json）。啟動與「重新載入」時以安裝時的同一套規則驗證；開發包沒有額外權力。
   *
   * @maxItems 8
   */
  dev_dirs?: string[];
  /**
   * 上傳的插件壓縮檔上限（bytes，邊收邊計數）；超過回 413 PAYLOAD_TOO_LARGE。
   */
  max_package_bytes?: number;
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "RuntimeEntry".
 */
export interface RuntimeEntry {
  runtime_id: string;
  python: string;
  module: string;
  env: {
    [k: string]: string | undefined;
  };
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "NodeConfig".
 */
export interface NodeConfig {
  node_id: string;
  label: string;
  bind_host: string;
  port: number;
  advertise_url: Endpoint;
  controller_url: Endpoint;
  data_dir: string;
  catalog_interval_seconds: number;
  load_timeout_seconds: number;
  cancel_grace_seconds: number;
  file_buffer_bytes: number;
  file_transfer_concurrency: number;
  /**
   * x-phasyn-extension：JSON request body 的上限（bytes）；超過回 413 PAYLOAD_TOO_LARGE
   */
  max_json_body_bytes?: number;
  /**
   * x-phasyn-extension：單一上傳檔的上限（bytes，邊收邊計數）；超過回 413 PAYLOAD_TOO_LARGE
   */
  max_upload_bytes?: number;
  /**
   * x-phasyn-extension：允許的 Host 標頭（主機名稱或 IP，不含 port，比對不分大小寫；IPv6 可寫 [::1] 或 ::1）。設定後只接受清單內的 Host，其他一律回 400 HOST_NOT_ALLOWED（防 DNS rebinding）；不設＝只接受 IP 位址、localhost、本機主機名稱、advertise_url 的主機與 bind_host；空陣列不允許（會擋掉所有請求，包含 Node 上報與轉送）。
   *
   * @minItems 1
   */
  allowed_hosts?: string[];
  /**
   * x-phasyn-extension：權重下載可以寫入的模型目錄（絕對路徑，或相對於設定檔所在目錄）。元件的 load.model_path 必須位於其中之一、或設定檔內任一元件的 load.model_path 之下，才能下載權重；不設＝只有設定檔內元件的 load.model_path。
   *
   * @maxItems 64
   */
  model_dirs?: string[];
  admission?: NodeAdmission;
  runtimes: RuntimeEntry[];
  components: InstanceDefinition[];
  recording: RecorderConfig;
  /**
   * Configured CUDA device IDs which allocate from host RAM. Placement counts these allocations once in the shared pool.
   *
   * @maxItems 64
   */
  unified_memory_devices?: string[];
  /**
   * x-phasyn-extension：自動清理已結束元件程序的工作目錄（data_dir/work/<component_id>/<process_instance_id>）。只刪除不是目前執行中程序、而且 ttl_hours 內整棵目錄都沒有變動的目錄；已發布檔、紀錄、日誌與 work/_describe 不動。每 interval_minutes 檢查一次，每次都記錄在 Node 日誌。不設＝開啟、24 小時、每 60 分鐘。
   */
  work_cleanup?: {
    enabled?: boolean;
    ttl_hours?: number;
    interval_minutes?: number;
  };
}
/**
 * x-phasyn-extension：主機保護（選用，給統一記憶體 GPU 主機）。受保護的呼叫在輸入就緒後、元件執行前，主機太熱或主記憶體不足時等待（呼叫期限照算，可以取消）；執行中超過緊急門檻時經 Node 自己的取消路徑停止（cooperative，逾時才終止自有 process group），結果為 failed／HOST_PROTECTION。其他呼叫不受影響。不設＝不取樣、不等待。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "NodeAdmission".
 */
export interface NodeAdmission {
  /**
   * 受保護的呼叫：元件的 exclusive_group 或 provider_id 在清單內（兩者合計至少一項）。
   */
  gated: {
    /**
     * @maxItems 64
     */
    exclusive_groups?: string[];
    /**
     * @maxItems 64
     */
    provider_ids?: string[];
  };
  /**
   * 溫度保護（°C）：晶片溫度＝chip_zone_glob 各 zone 的最大值（m°C），GPU 溫度取自 NVML（受保護元件的 CUDA 裝置）。晶片 ≥ pause_at_c 時暫停新的受保護呼叫（進行中的繼續），降到 resume_below_c 以下才恢復；執行中晶片 ≥ cancel_chip_at_c 或 GPU ≥ cancel_gpu_at_c 就取消該呼叫。每 sample_seconds 取樣一次，暫停中或 ≥ resume_below_c 時每 hot_sample_seconds 一次。必須 resume_below_c < pause_at_c < cancel_chip_at_c，且 hot_sample_seconds ≤ sample_seconds。讀不到的感測器不擋呼叫（fail-open）。
   */
  thermal?: {
    chip_zone_glob?: string;
    pause_at_c: number;
    resume_below_c: number;
    cancel_chip_at_c: number;
    cancel_gpu_at_c: number;
    sample_seconds?: number;
    hot_sample_seconds?: number;
  };
  /**
   * 主記憶體保護（/proc/meminfo 的 MemAvailable，bytes）：可用 ≥ start_min_available_bytes 才開始受保護的呼叫；執行中低於 cancel_below_available_bytes 就取消該呼叫（每 sample_seconds 取樣；0＝不取消）。start_min_available_bytes 不能小於 cancel_below_available_bytes。
   */
  memory?: {
    start_min_available_bytes: number;
    cancel_below_available_bytes: number;
    sample_seconds?: number;
  };
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "Rational".
 */
export interface Rational {
  num: number;
  den: number;
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "TensorDescriptor".
 */
export interface TensorDescriptor {
  key: string;
  /**
   * @minItems 1
   */
  shape: number[];
  dtype: "F16" | "BF16" | "F32" | "I64" | "BOOL" | "U8";
  layout: string;
  domain: string;
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "FinalLatentManifest".
 */
export interface FinalLatentManifest {
  schema_version: "4.0";
  latent_id: string;
  stage: "final";
  latent_space_id: string;
  tensor: TensorDescriptor;
  target: {
    width: number;
    height: number;
    frames: number;
    fps: Rational;
  };
  blob: FileRef;
  generation_run_id: string;
  generator_identity: {
    [k: string]: unknown | undefined;
  };
  binding: {
    [k: string]: unknown | undefined;
  };
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "LatentRef".
 */
export interface LatentRef {
  latent_id: string;
  blob_sha256: string;
  manifest_sha256: string;
  manifest_file: FileRef;
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "Asset".
 */
export interface Asset {
  asset_id: string;
  kind: "preview" | "final" | "video" | "audio";
  file: FileRef;
  source_latent: LatentRef | null;
  frame_count: number;
  fps: Rational | null;
  width: number;
  height: number;
  complete: boolean;
  actual_settings: {
    [k: string]: unknown | undefined;
  };
  /**
   * Whether the final published container has an audio stream, when known by the writer.
   */
  has_audio?: boolean;
}
/**
 * x-phasyn-extension：image.asset.v1 的值（圖片元件的輸出；file 是 PNG）。mode＝PNG 色彩模式；has_alpha＝實際有透明像素；white_matte＝alpha 已鋪在白底上（RGB，H3 ref2va 參考圖／fl2va 首幀用這一張）；source_take＝Studio 專案中的來源（元件輸出時為 null，由前端記錄）；actual_settings＝產生它的元件實際使用的設定（含上游 latent 的 seed／steps／sigmas 與模型身分）。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "ImageAsset".
 */
export interface ImageAsset {
  asset_id: string;
  file: FileRef;
  width: number;
  height: number;
  mode: "RGBA" | "RGB";
  has_alpha: boolean;
  white_matte: boolean;
  source_take: {
    project_id: string;
    image_shot_id: string;
    take_id: string;
  } | null;
  actual_settings: {
    [k: string]: unknown | undefined;
  };
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "FrameEvidence".
 */
export interface FrameEvidence {
  frame_id: string;
  source_pts: number;
  time_base: Rational;
  time_seconds: number;
  file: FileRef | null;
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "SceneEntity".
 */
export interface SceneEntity {
  entity_id: string;
  kind: string;
  description: string;
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "SceneEvent".
 */
export interface SceneEvent {
  event_id: string;
  entity_ids: string[];
  start_seconds: number;
  end_seconds: number;
  description: string;
  evidence_frame_ids: string[];
  certainty: "observed" | "uncertain";
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "SceneDocument".
 */
export interface SceneDocument {
  schema_version: "4.0";
  source: FileRef;
  duration_seconds: number;
  entities: SceneEntity[];
  initial_state: string;
  final_state: string;
  events: SceneEvent[];
  camera: string;
  evidence: FrameEvidence[];
  unknowns: string[];
  generation_edits: string[];
  caption_model: {
    [k: string]: unknown | undefined;
  };
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "CaptionPair".
 */
export interface CaptionPair {
  source: FileRef;
  scene_recording_id: string | null;
  training_caption: string;
  generation_prompt: string;
  include_uncertain: boolean;
  language: string;
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "DatasetManifest".
 */
export interface DatasetManifest {
  schema_version: "4.0";
  format: "video_text_pairs";
  items: {
    sample_id: string;
    relative_video_path: string;
    relative_caption_path: string;
    source: FileRef;
    source_group: string;
    split: "train" | "validation" | "test";
    caption: string;
  }[];
  notes: string[];
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "ListPipelines".
 */
export interface ListPipelines {
  items: Pipeline[];
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "ListRuns".
 */
export interface ListRuns {
  items: Run[];
  next_cursor: string | null;
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "ListComponents".
 */
export interface ListComponents {
  items: ComponentDescriptor[];
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "Preset".
 */
export interface Preset {
  preset_id: string;
  label: string;
  provider_id: string;
  settings: InstanceSettings;
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "PresetList".
 */
export interface PresetList {
  items: Preset[];
}
/**
 * x-phasyn-extension：主控自身資訊（顯示所在主機；不是身份）
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "ControllerInfo".
 */
export interface ControllerInfo {
  controller_id: string;
  label: string;
  endpoint: Endpoint;
  protocol_version: "4.0";
  version: string;
  platform: string;
  hostname: string;
  started_at: string;
  max_active_runs: number;
  node_stale_seconds: number;
}
/**
 * x-phasyn-extension：Node 上某 runtime 可用的 provider（describe 摘要，不載入模型）
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "ProviderInfo".
 */
export interface ProviderInfo {
  runtime_id: string;
  provider_id: string;
  kind: string;
  label: string;
  available: boolean;
  reason: string | null;
  synthetic: boolean;
  default_settings: InstanceSettings | null;
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "ProviderList".
 */
export interface ProviderList {
  node_id: string;
  items: ProviderInfo[];
}
/**
 * x-phasyn-extension：Studio 鏡頭的一次渲染。只保存 run 參照與當時參數；事實來源仍是 run 與 recording。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioTake".
 */
export interface StudioTake {
  take_id: string;
  run_id: string;
  output_key: string;
  created_at: string;
  state: "rendering" | "succeeded" | "failed" | "cancelled" | "interrupted";
  prompt: string | null;
  seed: number | null;
  frames: number;
  width: number;
  height: number;
  route: StudioRouteId;
  steps: number | null;
  asset: Asset | null;
  video_latent: FileRef | null;
  error: ApiErrorBody | null;
  timings_ms: {
    [k: string]: number | null | undefined;
  };
  /**
   * 此 take 生成時的首幀來源（選用；null 或缺少＝沒有首幀，t2va／ref2va）。previous_last：first_frame 是 media.frame 步驟輸出的 PNG，run 完成前為 null；image：素材庫圖片（item_id），first_frame 是送出時實際送進首幀輸入的檔案（之後素材庫移除這個項目，紀錄仍保留）。
   */
  continuity?:
    | null
    | {
        mode: "previous_last";
        source_shot_id: string;
        source_take_id: string;
        /**
         * 要求的來源影格序號（0 起）；null＝最後一個可解碼影格（前一個鏡頭沒有裁切出點）
         */
        source_frame_index: number | null;
        first_frame: FileRef | null;
      }
    | {
        mode: "image";
        item_id: string;
        first_frame: FileRef;
      };
  /**
   * 此 take 的 H3 任務（選用；舊 take 沒有此欄位＝t2va 或 fl2va 由 continuity 判斷）
   */
  task?: "t2va" | "fl2va" | "ref2va";
  /**
   * @maxItems 12
   */
  references?: StudioTakeReference[];
  /**
   * 渲染時套用的專案插件貢獻（選填；StudioPluginRef）。與專案目前的 prompt_plugins 不同時，這個 take 視為設定已變更、需要重新渲染。缺少＝沒有套用插件。
   *
   * @maxItems 8
   */
  prompt_plugins?: StudioPluginRef[];
  /**
   * 渲染時各插件貢獻的內容版本（選填）：鍵是 prompt_plugins 的引用，值是主控登錄表當時給的 rev。有這個欄位時，任一貢獻的 rev 與登錄表目前的不同，這個 take 也視為設定已變更；沒有這個欄位的舊 take 只比對 prompt_plugins。
   */
  prompt_plugin_revs?: {
    [k: string]: string | undefined;
  };
  /**
   * Original generation that published the staged video latent.
   */
  generation_run_id?: string;
  /**
   * Verified producing run of the parent draft used by this refinement.
   */
  parent_generation_run_id?: string;
  media_adoption?: StudioMediaAdoption;
  expected_fps?: Rational;
}
/**
 * x-phasyn-extension：take 生成時實際送出的參考素材（重現用）。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioTakeReference".
 */
export interface StudioTakeReference {
  /**
   * prompt 中的 @ 名稱（@Image1 → <Picture 1>、@Video1 → <Video 1>、@Audio1 → <Audio 1>）
   */
  alias: string;
  kind: "image" | "video" | "audio";
  file: FileRef;
  start_seconds: number | null;
  end_seconds: number | null;
  /**
   * 生成時這個參考影片在終點之後凍結最後一格（StudioReference.hold_last_frame）；只在為 true 時記錄。
   */
  hold_last_frame?: boolean;
}
/**
 * A deliberate editorial adoption of a published video with its immutable file inputs. The optional parent identifies a version in this shot.
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioMediaAdoption".
 */
export interface StudioMediaAdoption {
  method: "adopt_published_media";
  run_id: string;
  step_id: string;
  output_port: string;
  node_id: string;
  component_id: string;
  /**
   * @maxItems 128
   */
  source_inputs: {
    step_id: string;
    port: string;
    type_id: string;
    file: FileRef;
  }[];
  parent_take_id: string | null;
}
/**
 * x-phasyn-extension：時間軸上的一個鏡頭（prompt 與生成參數，以及它的 takes）。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioShot".
 */
export interface StudioShot {
  shot_id: string;
  title: string;
  prompt: string;
  frames: number;
  /**
   * -1＝每次渲染隨機選一個 seed（實際值記在 take.seed）；0 以上＝固定 seed。
   */
  seed: number;
  seed_locked: boolean;
  route: StudioRouteId;
  steps: number | null;
  video_shift: number | null;
  audio_shift: number | null;
  /**
   * Mirror kept by the Controller once the project has a timeline: true exactly when a timeline clip shows this shot. On a shot that was never placed, true asks for its place at the end of the first video track.
   */
  enabled: boolean;
  /**
   * Legacy trim (before the timeline was the edit state). Moved into the timeline clip by the Controller and reset to 0.
   */
  in_frame: number;
  /**
   * Legacy trim (before the timeline was the edit state). Moved into the timeline clip by the Controller and reset to null.
   */
  out_frame: number | null;
  /**
   * @maxItems 200
   */
  takes: StudioTake[];
  active_take_id: string | null;
  note: string;
  /**
   * 鏡頭的首幀（選用；沒有此欄位＝none）。previous_last＝以序列中前一個鏡頭使用中 take 的最後一個可解碼影格作為首幀；image＝以專案素材庫的一張圖片（item_id，StudioLibraryItem）作為首幀，原檔直接送進元件組合的首幀輸入。兩者都是 H3 fl2va。
   */
  continuity?:
    | {
        mode: "none" | "previous_last";
      }
    | {
        mode: "image";
        item_id: string;
      };
  /**
   * @maxItems 12
   */
  references?: StudioReference[];
  effects?: MediaClipEffects;
  previs?: StudioPrevis;
}
/**
 * x-phasyn-extension：鏡頭使用的參考素材（H3 ref2va：圖片 ≤ 9、影片 ≤ 3、聲音 ≤ 3、合計 1–12，不能只有聲音）。送出時依 alias 序號排列成 materials。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioReference".
 */
export interface StudioReference {
  ref_id: string;
  kind: "image" | "video" | "audio";
  /**
   * prompt 中的 @ 名稱（@Image1 → <Picture 1>、@Video1 → <Video 1>、@Audio1 → <Audio 1>）
   */
  alias: string;
  item_id: string;
  start_seconds: number | null;
  end_seconds: number | null;
  use_embedded_audio?: boolean | null;
  /**
   * 參考影片只用 start_seconds–end_seconds（end_seconds 為 null＝到檔案結尾），之後重複最後一格、聲音補靜音，補滿鏡頭的生成長度（H3 material hold_last_frame）：模型不會提早畫出終點之後的鏡頭。只對影片有效；官方 2–15 秒限制以補滿後的長度計，所以片段可以短於 2 秒。null 或省略＝不凍結。
   */
  hold_last_frame?: boolean | null;
}
/**
 * x-phasyn-extension：序列片段的剪輯效果（media.concat 以 FFmpeg 套用；Studio 鏡頭的 effects 用同一個形狀）。欄位缺少＝不套用；整個物件缺少（或全部是預設值）＝與沒有效果時完全相同的輸出。幀數一律是序列影格率下、套用速度後的片段幀：片段長度 m＝max(1, floor(裁切後幀數×100／speed_percent))＋hold.start＋hold.end，非 cut 的轉場與下一段重疊 frames 幀，序列總長＝Σm−Σ轉場幀數。淡入淡出、文字範圍與轉場都以含停格的 m 計算。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "MediaClipEffects".
 */
export interface MediaClipEffects {
  /**
   * 播放速度（百分比，100＝原速）。影片重新取樣（第 k 幀取素材第 floor(k×speed_percent／100) 幀），聲音以 atempo 變速不變調
   */
  speed_percent?: number;
  /**
   * 音量增益（dB，0＝不變）
   */
  volume_db?: number;
  /**
   * true＝這個片段輸出同長度的靜音
   */
  mute?: boolean;
  /**
   * 淡入淡出（幀）：影片自黑場淡入（第 0 幀全黑）、淡出到黑場（最後一幀全黑）；聲音自靜音淡入、淡出到靜音。淡入＋淡出不可超過片段長度。
   */
  fade?: {
    video_in?: number;
    video_out?: number;
    audio_in?: number;
    audio_out?: number;
  };
  /**
   * 基本色彩（FFmpeg eq）：brightness 亮度偏移（0＝不變）、contrast 對比（1＝不變）、saturation 飽和度（1＝不變）；invert＝負片（FFmpeg negate，先反相再套 eq；動作片的衝擊格常用）
   */
  color?: {
    brightness?: number;
    contrast?: number;
    saturation?: number;
    /**
     * true＝負片（反相）
     */
    invert?: boolean;
  };
  title?: MediaClipTitle;
  /**
   * 接到序列下一個片段的轉場：cut＝直接切換；crossfade＝交叉溶接（影像與聲音同時交叉淡化）；dip_to_black＝先暗到黑場再亮起（聲音前半淡出、後半淡入）；dip_to_white＝先亮到白場再回到畫面（閃白，聲音與 dip_to_black 相同）。非 cut 的轉場與下一段重疊 frames 幀；每個片段的進場＋出場轉場不可超過片段長度；序列最後一個片段只能是 cut。push＝前一段往 direction 推出、下一段從另一側推入；slide＝下一段從另一側滑入蓋住前一段（前一段不動）；whip＝甩鏡：像 push 但中段帶強烈的方向模糊；wipe＝以 direction 移動的邊界（softness 柔邊）揭開下一段；zoom＝in 時前一段放大穿越到下一段、out 相反。這些轉場的聲音與 crossfade 相同；easing 缺少時為 ease_in_out。cut＝轉場所在的切點（MediaClipTransitionCut）：對齊方式與兩個片段在切點外借出的影格；套用、變更或移除轉場只延長或收回這兩個片段，其他片段不動、序列長度不變。沒有 cut 的轉場以重疊的中點為切點。
   */
  transition_out?:
    | {
        kind: "cut";
      }
    | {
        kind: "crossfade" | "dip_to_black" | "dip_to_white";
        frames: number;
        cut?: MediaClipTransitionCut;
      }
    | {
        kind: "push" | "slide" | "whip";
        frames: number;
        /**
         * Where the movement goes: left = the pictures move toward the left edge.
         */
        direction: "left" | "right" | "up" | "down";
        /**
         * Progress curve of the movement; missing = ease_in_out.
         */
        easing?: "linear" | "ease_in" | "ease_out" | "ease_in_out";
        cut?: MediaClipTransitionCut;
      }
    | {
        kind: "wipe";
        frames: number;
        /**
         * Where the movement goes: left = the pictures move toward the left edge.
         */
        direction: "left" | "right" | "up" | "down";
        /**
         * Width of the soft wipe edge relative to the travel; 0 = hard edge, missing = 0.05.
         */
        softness?: number;
        /**
         * Progress curve of the movement; missing = ease_in_out.
         */
        easing?: "linear" | "ease_in" | "ease_out" | "ease_in_out";
        cut?: MediaClipTransitionCut;
      }
    | {
        kind: "zoom";
        frames: number;
        /**
         * in = the outgoing picture zooms toward the viewer into the incoming one; out = the reverse.
         */
        direction: "in" | "out";
        /**
         * Progress curve of the movement; missing = ease_in_out.
         */
        easing?: "linear" | "ease_in" | "ease_out" | "ease_in_out";
        cut?: MediaClipTransitionCut;
      };
  /**
   * 停格（幀）：start＝把片段第一幀重複 start 幀放在開頭，end＝把最後一幀重複 end 幀接在結尾（動作片的 hit-stop：在命中處分割鏡頭，前段設 end 或後段設 start）。停格期間的聲音是靜音；片段長度 m 加上這些幀。
   */
  hold?: {
    start?: number;
    end?: number;
  };
  /**
   * 動畫拍數（有限動畫）：1＝每幀都不同（預設）、2＝一拍二（每張畫停 2 幀）、3＝一拍三、4＝一拍四。在套用速度之後取每 frame_step 幀的第一幀並重複，片段長度不變；聲音不受影響。
   */
  frame_step?: number;
  /**
   * 鏡頭運動：zoom_percent＝以畫面中心推近（100＝不變，200＝放大兩倍；先裁切再縮放回序列尺寸）；shake_px＋shake_frames＝從片段第一幀開始的衝擊震動，振幅 shake_px（序列像素）在 shake_frames 幀內線性衰減到 0。有震動時整段畫面會再放大 shake_px 的邊界（震動需要的留邊）。
   */
  camera?: {
    zoom_percent?: number;
    shake_px?: number;
    shake_frames?: number;
  };
  /**
   * 衝擊格：片段開頭 frames 幀換成衝擊畫面，片段長度不變（動作動畫在命中瞬間插入的 1–3 張；常放在命中後那一段的開頭）。style：negative＝黑白負片高對比（negate＋去色＋對比 1.8）、white＝全白、black＝全黑。以 FFmpeg 的 timeline 選項（enable）只套用在這些幀；frames 不可超過片段長度。
   */
  impact?: {
    frames: number;
    style: "negative" | "white" | "black";
  };
}
/**
 * x-phasyn-extension：片段上的文字標題。文字由 Studio 在瀏覽器排版成與序列同尺寸的透明 PNG（image），media.concat 以 FFmpeg overlay 疊在片段的 [start_frame, end_frame) 幀（套用速度後的片段幀，0 起算）；伺服器端不排字（不依賴 FFmpeg drawtext 與字型）。image 為 null＝尚未產生圖層，匯出會被拒絕。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "MediaClipTitle".
 */
export interface MediaClipTitle {
  text: string;
  /**
   * 版面位置：top 上方置中、center 正中央、bottom 下方置中、lower_third 左下三分之一（字幕條）
   */
  position: "top" | "center" | "bottom" | "lower_third";
  /**
   * 字級（相對畫面高度：small 5%、medium 7.5%、large 11%）
   */
  size: "small" | "medium" | "large";
  start_frame: number;
  /**
   * 結束幀（不含）；null＝到片段結尾
   */
  end_frame: number | null;
  /**
   * 排版後的透明 PNG（media_type image/png，寬高＝序列尺寸）；null＝尚未產生
   */
  image: FileRef | null;
  /**
   * 產生 image 時的排版依據（文字、位置、字級、尺寸）；與目前設定不同＝圖層過期，需要重新產生
   */
  image_key?: string | null;
  style?: MediaClipTitleStyle;
}
/**
 * Optional custom text layout. x anchors horizontal alignment; y is the text block vertical centre. Absent style preserves legacy position/size rendering.
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "MediaClipTitleStyle".
 */
export interface MediaClipTitleStyle {
  font_family: "sans" | "serif" | "mono";
  /**
   * Font size in pixels relative to a 1080-line frame.
   */
  font_size: number;
  font_weight: 400 | 700;
  color: string;
  align: "left" | "center" | "right";
  x: number;
  y: number;
}
/**
 * The cut a transition sits on and what the two clips lend it beyond the cut (Premiere's alignment and handles). The cut is outgoing.frames before the end of the outgoing clip and incoming.frames after the start of the incoming clip; outgoing.frames + incoming.frames = frames. Applying, changing or removing the transition only lengthens or shortens the two clips at the cut: no other clip moves and the sequence keeps its length. A transition without cut (made before cuts were recorded) has its cut in the middle of the overlap (frames // 2 after the incoming clip's start). The export does not send it.
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "MediaClipTransitionCut".
 */
export interface MediaClipTransitionCut {
  /**
   * Where the transition sits on the cut: center = centred on it (an odd length has its extra frame after the cut), start = it begins at the cut (only the outgoing clip runs on), end = it ends at the cut (only the incoming clip starts earlier).
   */
  alignment: "center" | "start" | "end";
  outgoing: MediaClipTransitionSide;
  incoming: MediaClipTransitionSide;
}
/**
 * What one clip lends a transition beyond the cut: the clip's own hidden output first, then source frames beyond its range, then a freeze of its edge frame. Never frames past either end of the source.
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "MediaClipTransitionSide".
 */
export interface MediaClipTransitionSide {
  /**
   * Frames of the overlap on this side of the cut: after it for the outgoing clip, before it for the incoming clip.
   */
  frames: number;
  /**
   * Sequence frames by which the transition extended the clip's source range (out_frame of the outgoing clip, in_frame of the incoming clip) to reach them; removing the transition takes them back while they are still hidden beyond the cut.
   */
  source: number;
  /**
   * Frames the transition added to the clip's hold at this edge (hold.end of the outgoing clip, hold.start of the incoming clip) where the media ran out: they repeat the clip's last or first frame (insufficient media). Removing the transition takes them back while they are still hidden beyond the cut.
   */
  freeze: number;
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioPrevis".
 */
export interface StudioPrevis {
  version: 1;
  background: string;
  projection: "orthographic" | "perspective" | "stage3d";
  /**
   * @minItems 1
   * @maxItems 24
   */
  camera: StudioPrevisPose[];
  /**
   * @minItems 0
   * @maxItems 12
   */
  layers: StudioPrevisLayer[];
  /**
   * @minItems 1
   * @maxItems 24
   */
  lens_keys?: StudioPrevisCamera3D[];
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioPrevisPose".
 */
export interface StudioPrevisPose {
  frame: number;
  x: number;
  y: number;
  scale: number;
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioPrevisLayer".
 */
export interface StudioPrevisLayer {
  id: string;
  name: string;
  kind: "figure" | "rectangle" | "image" | "puppet";
  item_id: string | null;
  color: string;
  /**
   * @minItems 1
   * @maxItems 24
   */
  keys: StudioPrevisPose[];
  z_m?: number;
  /**
   * @minItems 1
   * @maxItems 24
   */
  rig_keys?: StudioPrevisRig[];
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioPrevisRig".
 */
export interface StudioPrevisRig {
  frame: number;
  body_yaw: number;
  body_pitch: number;
  head_yaw: number;
  left_arm_raise: number;
  left_arm_spread: number;
  left_elbow: number;
  left_hip: number;
  left_leg_spread: number;
  left_knee: number;
  right_arm_raise: number;
  right_arm_spread: number;
  right_elbow: number;
  right_hip: number;
  right_leg_spread: number;
  right_knee: number;
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioPrevisCamera3D".
 */
export interface StudioPrevisCamera3D {
  frame: number;
  x: number;
  y: number;
  z: number;
  target_x: number;
  target_y: number;
  target_z: number;
  focal_mm: number;
}
/**
 * x-phasyn-extension：一次序列匯出（media.concat 的 run 參照）。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioExport".
 */
export interface StudioExport {
  export_id: string;
  run_id: string;
  created_at: string;
  state: "rendering" | "succeeded" | "failed" | "cancelled" | "interrupted";
  /**
   * @maxItems 500
   */
  shot_ids: string[];
  asset: Asset | null;
  error: ApiErrorBody | null;
  frames: number | null;
}
/**
 * x-phasyn-extension：Studio 專案文件（主控 data_dir/config/studio）；revision 用於樂觀並行控制。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioProject".
 */
export interface StudioProject {
  project_id: string;
  title: string;
  revision: number;
  created_at: string;
  updated_at: string;
  format: {
    width: number;
    height: number;
    fps: Rational;
  };
  /**
   * 匯出尺寸（選填）：序列匯出成 width×height，fit 決定縮放方式（MediaSequence.fit）。缺少＝與 format 相同的尺寸、contain。渲染尺寸仍是 format；匯出尺寸只影響序列匯出（例如以 1280×736 渲染、匯出 1280×720）。
   */
  export_format?: {
    width: number;
    height: number;
    fit: "contain" | "cover";
  };
  /**
   * 專案選用的插件貢獻（選填；StudioPluginRef）：規則與生成設定的引用，定義來自主控的插件登錄表（GET /api/studio/plugins）。Studio 渲染前把規則套用到每個鏡頭的 prompt，並檢查生成設定的要求；引用找不到、所屬的包停用或不相容、或讀不到登錄表時不能渲染。缺少或空陣列＝不套用。
   *
   * @maxItems 8
   */
  prompt_plugins?: StudioPluginRef[];
  defaults: {
    frames: number;
    route: StudioRouteId;
    steps: number | null;
  };
  /**
   * @maxItems 500
   */
  shots: StudioShot[];
  /**
   * @maxItems 200
   */
  exports: StudioExport[];
  /**
   * @maxItems 500
   */
  library?: StudioLibraryItem[];
  /**
   * Image Studio 的圖片鏡頭（選用；舊專案沒有此欄位＝沒有圖片鏡頭）。與 Video Studio 共用同一個專案與素材庫。
   *
   * @maxItems 500
   */
  image_shots?: StudioImageShot[];
  timeline?: StudioTimeline;
}
/**
 * x-phasyn-extension：專案素材庫的一個上傳檔（參考圖片／影片／聲音）。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioLibraryItem".
 */
export interface StudioLibraryItem {
  item_id: string;
  kind: "image" | "video" | "audio";
  name: string;
  file: FileRef;
  created_at: string;
  duration_seconds: number | null;
  width: number | null;
  height: number | null;
  has_audio: boolean | null;
  note?: string;
  /**
   * 素材來源（選用；沒有此欄位＝使用者上傳）。image_take＝Image Studio 某個 take 加入素材庫（白底版本）。
   */
  source?:
    | {
        kind: "image_take";
        image_shot_id: string;
        take_id: string;
      }
    | {
        kind: "upload";
      }
    | {
        kind: "run_output";
        run_id: string;
        output_key: string;
      };
}
/**
 * x-phasyn-extension：Image Studio 的一個圖片鏡頭（文生圖／圖生圖的參數與它的 takes）。寬高是 32 的倍數（Qwen-Image 2.1 一個影像 slot＝2×2 latent token＝32 px；不自動取整）。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioImageShot".
 */
export interface StudioImageShot {
  image_shot_id: string;
  title: string;
  mode: "t2i" | "i2i";
  prompt: string;
  negative_prompt: string;
  width: number;
  height: number;
  /**
   * -1＝每張隨機（實際值記在 take.seed）；0 以上依 seed_mode 使用（qimg.dit 的 seed 上限 2147483647）
   */
  seed: number;
  seed_mode: "fixed" | "increment" | "random";
  batch: number;
  steps: number;
  /**
   * true CFG scale（Qwen 語意）：≤ 1 不做 CFG；> 1 編碼 negative_prompt，每步 forward 加倍
   */
  guidance: number;
  sigma_schedule: "native" | "karras" | "exponential";
  flow_shift_mu: number | null;
  route: StudioRouteId;
  /**
   * @maxItems 4
   */
  references: {
    item_id: string;
    order: number;
  }[];
  base_index: number | null;
  reference_resolution: number;
  mask_item_id: string | null;
  mask_invert: boolean;
  decode: "full" | "tiled";
  preview: {
    mode: "off" | "vae_thumbnail" | "linear_fit";
    every: number;
  };
  /**
   * @maxItems 200
   */
  takes: StudioImageTake[];
  active_take_id: string | null;
  note: string;
}
/**
 * x-phasyn-extension：Image Studio 圖片鏡頭的一次生成（一張圖一個 take；batch N＝同一個 run 的 N 個 take）。只保存 run 參照與當時參數；事實來源仍是 run 與 recording。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioImageTake".
 */
export interface StudioImageTake {
  take_id: string;
  run_id: string;
  created_at: string;
  state: "rendering" | "succeeded" | "failed" | "cancelled" | "interrupted";
  /**
   * 實際使用的 seed（-1／random 已在送出前解析並記錄；與 qimg.dit 的 seed 範圍相同）
   */
  seed: number;
  image: ImageAsset | null;
  image_white: ImageAsset | null;
  library_item_id: string | null;
  timings_ms: {
    [k: string]: number | null | undefined;
  };
  error: ApiErrorBody | null;
  /**
   * 送出時的生成參數快照（「載入這組參數」與 batch 分支對應用）
   */
  params_snapshot: {
    [k: string]: unknown | undefined;
  };
}
/**
 * The single edit state of a Studio project. The Controller creates it from the first shot, gives every enabled new shot its place, binds sources to the shots' active takes and moves legacy shot trims and effects into it. All frame coordinates use fps. Tracks are bottom-to-top compositing order; audio tracks mix independently. The film order of shots is the order of clips on the first video track. Maximum duration 100000 frames and one hour.
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioTimeline".
 */
export interface StudioTimeline {
  /**
   * 2 = kept consistent with shots and takes by the Controller. Version 1 documents are accepted and upgraded on read and write.
   */
  version: 1 | 2;
  fps: Rational;
  /**
   * @maxItems 500
   */
  sources: TimelineSource[];
  /**
   * @maxItems 16
   */
  tracks: TimelineTrack[];
  /**
   * @maxItems 1000
   */
  clips: TimelineClip[];
  /**
   * @maxItems 500
   */
  captions: TimelineCaption[];
  /**
   * @maxItems 500
   */
  markers: TimelineMarker[];
  master_gain_db: number;
  work_area?: TimelineRange;
  /**
   * Shots that have had their place on the timeline. A shot listed here is never placed again by the Controller, so a shot whose clips were removed stays out of the film.
   *
   * @maxItems 500
   */
  placed_shot_ids?: string[];
  /**
   * Sentences (Traditional Chinese) about legacy shot values the Controller had to adjust when it moved them into the timeline. The editor shows them once and removes them.
   *
   * @maxItems 64
   */
  migration_notes?: string[];
}
/**
 * Original media reference. duration_frames and clip in/out use the sequence FPS, after source FPS normalization; a video or audio source may be up to 24 hours long (longer than a sequence: the sequence limit applies to clips). A source with shot_id follows that shot's active take: file is null with the shot's planned length until a take exists, and pending_take_id names a take that is too short for the edit. Proxy is playback-only; export always resolves file. Text sources are generated composition media: file is null, has_audio is false, and the referencing clip carries effects.title. Adjustment sources are generated as well (file null, has_audio false, no shot, take, library or proxy): a clip of one has no picture of its own and applies its color, effect stack, mask, fades (as its coverage), opacity and blend mode to the composite of the video tracks below it within its frames.
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "TimelineSource".
 */
export interface TimelineSource {
  source_id: string;
  name: string;
  kind: "video" | "audio" | "image" | "text" | "adjustment";
  file: FileRef | null;
  duration_frames: number;
  width: number;
  height: number;
  has_audio: boolean;
  shot_id?: string;
  take_id?: string;
  library_id?: string;
  proxy?: Asset;
  proxy_run_id?: string;
  proxy_error?: string;
  proxy_source_sha256?: string;
  /**
   * The shot's active take when it cannot replace the bound media by itself: it is shorter than a clip of this source uses. Cleared when the take is applied (reconcile) or no longer applies.
   */
  pending_take_id?: string;
  /**
   * Identity of a version-pinned candidate. Its file and range remain fixed when the active shot take changes.
   */
  candidate_origin?: {
    source_id: string;
    shot_id?: string;
    take_id?: string;
    library_id?: string;
    run_id?: string;
    output_key?: string;
  };
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "TimelineTrack".
 */
export interface TimelineTrack {
  track_id: string;
  name: string;
  kind: "video" | "audio";
  locked: boolean;
  muted: boolean;
  solo: boolean;
  sync_lock: boolean;
  gain_db: number;
  pan: number;
}
/**
 * Non-destructive clip instance. Complete processed duration uses MediaClipEffects retiming and holds. Optional output_window selects a visible interval after all clip effects and motion; omission means the entire processed clip. The source in/out range, keys, title, fades, holds and impact remain in the complete processed timebase. Visible duration determines placement, sequence length and transition overlap; transition-linked clips must share a blend mode. Video tracks only draw pictures; audio is placed on independent linked audio clips. Missing effect_stack, mask and blend_mode preserve legacy behavior: no added effects, no mask and normal compositing. Effects run in array order after legacy color/title, then mask, fade and motion. in_frame and out_frame are source frames and may lie anywhere in a source of up to 24 hours; the sequence limit applies to the clip's processed length, not to where its range sits in the source. A disabled clip (enabled: false) stays in the document and is validated like any clip. A clip of an adjustment source keeps position, scale, rotation and its sound at rest (opacity may be animated), its effects hold only color and video fades, and it takes no transition.
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "TimelineClip".
 */
export interface TimelineClip {
  clip_id: string;
  source_id: string;
  track_id: string;
  name: string;
  start_frame: number;
  in_frame: number;
  out_frame: number;
  output_window?: TimelineOutputWindow;
  linked_id?: string;
  effects?: MediaClipEffects;
  motion: TimelineMotion;
  /**
   * @maxItems 8
   */
  effect_stack?: TimelineEffect[];
  mask?: TimelineMask;
  blend_mode?: "normal" | "multiply" | "screen" | "add";
  /**
   * false = the clip keeps its place and its validation but is skipped by preview and export.
   */
  enabled?: boolean;
}
/**
 * Half-open window [start_frame,end_frame) in the complete processed clip, after source trim, retiming, holds, titles, clip effects, masks, fades and motion. Start must precede end and end must not exceed the complete processed duration. Coordinates do not restart effect or audio clocks. Transitions are applied after this window, at its visible edges.
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "TimelineOutputWindow".
 */
export interface TimelineOutputWindow {
  start_frame: number;
  end_frame: number;
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "TimelineMotion".
 */
export interface TimelineMotion {
  x: number;
  y: number;
  scale: number;
  rotation: number;
  opacity: number;
  gain_db: number;
  pan: number;
  keyframes: {
    /**
     * @maxItems 128
     */
    x?: TimelineKeyframe[];
    /**
     * @maxItems 128
     */
    y?: TimelineKeyframe[];
    /**
     * @maxItems 128
     */
    scale?: TimelineKeyframe[];
    /**
     * @maxItems 128
     */
    rotation?: TimelineKeyframe[];
    /**
     * @maxItems 128
     */
    opacity?: TimelineKeyframe[];
    /**
     * @maxItems 128
     */
    gain_db?: TimelineKeyframe[];
    /**
     * @maxItems 128
     */
    pan?: TimelineKeyframe[];
  };
}
/**
 * Interpolation belongs to the left key. For segment progress t: ease_in=t*t, ease_out=1-(1-t)*(1-t), ease_in_out=t*t*(3-2*t). Values hold outside the keyed range. Bezier interpolation uses bezier controls and the same optional curve_range domain. The left key owns both controls and interval; values at segment endpoints are exact.
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "TimelineKeyframe".
 */
export interface TimelineKeyframe {
  frame: number;
  value: number;
  interpolation: "linear" | "hold" | "ease_in" | "ease_out" | "ease_in_out" | "bezier";
  /**
   * Optional easing domain [a,b], 0 <= a < b <= 1; defaults to [0,1]. Progress u evaluates (E(a+(b-a)*u)-E(a))/(E(b)-E(a)), preserving a trimmed eased segment. Ignored for linear and hold.
   *
   * @minItems 2
   * @maxItems 2
   */
  curve_range?: number[];
  /**
   * Required for bezier interpolation: normalized cubic controls [x1,y1,x2,y2] between (0,0) and (1,1). Invert x with 32 bisections, then evaluate y. Bounded controls preserve parameter bounds.
   *
   * @minItems 4
   * @maxItems 4
   */
  bezier?: number[];
}
/**
 * Sequence-normalized mask before clip motion. The rectangle must remain inside the sequence. Feather is an inward smooth edge width relative to the shorter sequence side; invert reverses coverage. Animated width and height keys are at least 0.01. Animated geometry may cross sequence edges and is clipped to the canvas; the fixed rectangle remains inside the sequence.
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "TimelineMask".
 */
export interface TimelineMask {
  kind: "rectangle" | "ellipse";
  x: number;
  y: number;
  width: number;
  height: number;
  feather: number;
  invert: boolean;
  /**
   * Optional parameter automation in clip-local output frames, after retiming and holds. Missing or empty channels use the fixed parameter value.
   */
  keyframes?: {
    /**
     * @maxItems 128
     */
    x?: TimelineKeyframe[];
    /**
     * @maxItems 128
     */
    y?: TimelineKeyframe[];
    /**
     * @maxItems 128
     */
    width?: TimelineKeyframe[];
    /**
     * @maxItems 128
     */
    height?: TimelineKeyframe[];
    /**
     * @maxItems 128
     */
    feather?: TimelineKeyframe[];
  };
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "TimelineCaption".
 */
export interface TimelineCaption {
  caption_id: string;
  start_frame: number;
  end_frame: number;
  text: string;
  position: "top" | "center" | "bottom" | "lower_third";
  size: "small" | "medium" | "large";
  image?: FileRef;
  image_key?: string;
  transcription?: {
    start_frame: number;
    end_frame: number;
    text: string;
    size: "small" | "medium" | "large";
    position: "top" | "center" | "bottom" | "lower_third";
    clip_id: string;
    run_id: string;
    output_key: string;
    start_ms: number;
    end_ms: number;
    source_sha256: string;
    file: FileRef;
    needs_review: boolean;
  };
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "TimelineMarker".
 */
export interface TimelineMarker {
  marker_id: string;
  frame: number;
  name: string;
  color: "blue" | "green" | "amber" | "rose" | "violet";
}
/**
 * Half-open sequence range [start_frame,end_frame). Start must precede end.
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "TimelineRange".
 */
export interface TimelineRange {
  start_frame: number;
  end_frame: number;
}
/**
 * x-phasyn-extension：專案列表的一列。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioProjectSummary".
 */
export interface StudioProjectSummary {
  project_id: string;
  title: string;
  revision: number;
  created_at: string;
  updated_at: string;
  shot_count: number;
  rendered_shot_count: number;
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioProjectList".
 */
export interface StudioProjectList {
  items: StudioProjectSummary[];
}
export interface MediaSequence1 {
  /**
   * @minItems 0
   * @maxItems 200
   */
  clips: {
    asset: Asset;
    in_frame: number;
    out_frame: number | null;
    effects?: MediaClipEffects;
  }[];
  width?: number;
  height?: number;
  fps?: Rational;
  /**
   * 片段縮放到序列尺寸的方式：contain＝完整放入、不足處補黑邊（缺少時的行為）；cover＝填滿畫面、裁掉超出的邊緣（例如 1280×736 的鏡頭匯出成 1280×720）。有 fit 時縮放使用 lanczos。
   */
  fit?: "contain" | "cover";
  audio_track?: MediaSequenceAudioTrack;
  timeline?: StudioTimeline;
  render_range?: TimelineRange;
}
/**
 * x-phasyn-extension：media.concat 的外部音軌（MediaSequence.audio_track）。有此欄位時，匯出的聲音＝file 的第一條音軌從 start_seconds 起、長度剛好等於序列總長（套用速度與轉場之後的計畫幀數÷影格率；48 kHz sample 精準），來源比起點晚開始或提早結束的部分以靜音補齊並寫進 actual_settings.concat.notes；片段原本的聲音與聲音效果（音量、靜音、聲音淡入淡出、聲音轉場）都不使用，影片（接合、效果、幀數驗證）不受影響。start_seconds 以來源影片軌第一幀為 0（純音訊檔以音軌起點為 0），與 MediaInfo.scene_cuts_seconds 同一個時間軸。file 沒有音軌、或 start_seconds 已超過音軌結尾時匯出失敗（INVALID_ARGUMENT），不輸出靜音假裝成功。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "MediaSequenceAudioTrack".
 */
export interface MediaSequenceAudioTrack {
  file: FileRef;
  start_seconds: number;
  gain_db?: number;
}
/**
 * x-phasyn-extension：media.probe.v1 的值（media.probe 的輸出；ffprobe 標頭事實，未知為 null）。帶 invoke 參數 scenes 時另含 scene_cuts_seconds 與 scene_detection；沒有 scenes（或 null）時這兩個欄位不存在，輸出與加入偵測之前完全相同。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "MediaInfo".
 */
export interface MediaInfo {
  kind: "image" | "video" | "audio";
  format_name: string;
  duration_seconds: number | null;
  width: number | null;
  height: number | null;
  fps_num: number | null;
  fps_den: number | null;
  frame_count: number | null;
  pixel_format: string | null;
  color_primaries: string | null;
  color_transfer: string | null;
  color_space: string | null;
  color_range: string | null;
  has_audio: boolean;
  audio_sample_rate: number | null;
  audio_channels: number | null;
  audio_channel_layout: string | null;
  video_codec: string | null;
  audio_codec: string | null;
  size_bytes: number;
  frame_count_exact: boolean;
  rotation_degrees: number | null;
  video_streams: number;
  audio_streams: number;
  has_b_frames: number | null;
  /**
   * 鏡頭切換點：新鏡頭第一幀的秒數（以影片軌第一幀為 0，微秒精度），遞增、在 (0, duration_seconds) 內，兩兩至少相距 scene_detection.min_gap_seconds
   *
   * @maxItems 5000
   */
  scene_cuts_seconds?: number[];
  /**
   * 偵測實際使用的參數（invoke 參數 scenes 補上預設值後的結果）
   */
  scene_detection?: MediaSceneDetection | null;
  frame_clock?: {
    kind: "cfr";
    fps: {
      num: number;
      den: number;
    };
    frame_count: number;
    source_sha256: string;
    source_size_bytes: number;
    first_pts: number;
    time_base: {
      num: number;
      den: number;
    };
  };
  clip_origin_offset?: {
    num: number;
    den: number;
  };
}
/**
 * x-phasyn-extension：media.probe 鏡頭切換偵測實際使用的參數（MediaInfo.scene_detection）。invoke 參數 scenes 是同一個形狀，但兩個欄位都可省略（threshold 預設 0.3、min_gap_seconds 預設 0.5）；scenes 為 null 或省略＝不偵測。FFmpeg select filter 的 scene 分數（0–1）大於 threshold 的影格算一個切換點；相距小於 min_gap_seconds 的切換點只保留分數最高的一個（同分保留較早的）。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "MediaSceneDetection".
 */
export interface MediaSceneDetection {
  threshold: number;
  min_gap_seconds: number;
}
/**
 * x-phasyn-extension：固定 Prompt（片段庫的一筆，可插入到任何鏡頭的 prompt）。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioPromptSnippet".
 */
export interface StudioPromptSnippet {
  snippet_id: string;
  title: string;
  text: string;
  category: string | null;
  created_at: string;
  updated_at: string;
}
/**
 * x-phasyn-extension：固定 Prompt 片段庫（主控 data_dir/config/studio；revision 樂觀並行，新庫為 0）。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioPromptLibrary".
 */
export interface StudioPromptLibrary {
  revision: number;
  updated_at: string | null;
  /**
   * @maxItems 1000
   */
  snippets: StudioPromptSnippet[];
}
/**
 * x-phasyn-extension：插件的短文字（名稱、標籤、標題），依語言分開；至少一種。顯示順序：介面語言 → en → zh-Hant → 其餘任一種。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioPluginLabel".
 */
export interface StudioPluginLabel {
  "zh-Hant"?: string;
  en?: string;
  ja?: string;
}
/**
 * x-phasyn-extension：插件的說明文字（說明、規則訊息），依語言分開；至少一種。顯示順序與 StudioPluginLabel 相同。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioPluginText".
 */
export interface StudioPluginText {
  "zh-Hant"?: string;
  en?: string;
  ja?: string;
}
/**
 * x-phasyn-extension：規則的禁止項目（正規表示式）：prompt 命中 pattern 就不能渲染。只有內建包可以使用；pattern 必須同時是合法的 JavaScript 與 Python 正規表示式，比對不分大小寫。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioPluginForbidPattern".
 */
export interface StudioPluginForbidPattern {
  id: string;
  pattern: string;
  message: StudioPluginText;
}
/**
 * x-phasyn-extension：規則的禁止項目（詞組清單）：prompt 含有任一詞組就不能渲染。比對規則（兩個評估器相同）：ASCII 字母不分大小寫；連續的空白與連字號視為同一個分隔；word=true 時詞組前後必須是字界（前後不是 ASCII 英數字或底線）。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioPluginForbidTerms".
 */
export interface StudioPluginForbidTerms {
  id: string;
  /**
   * @minItems 1
   * @maxItems 64
   */
  terms: string[];
  word?: boolean;
  message: StudioPluginText;
}
/**
 * x-phasyn-extension：規則的必要項目（正規表示式）：prompt 必須命中 any_of，否則不能渲染。只有內建包可以使用；規則與 StudioPluginForbidPattern 相同。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioPluginRequirePattern".
 */
export interface StudioPluginRequirePattern {
  id: string;
  any_of: string;
  message: StudioPluginText;
}
/**
 * x-phasyn-extension：規則的必要項目（詞組清單）：prompt 必須含有至少一個詞組，否則不能渲染。比對規則與 StudioPluginForbidTerms 相同。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioPluginRequireTerms".
 */
export interface StudioPluginRequireTerms {
  id: string;
  /**
   * @minItems 1
   * @maxItems 64
   */
  any_terms: string[];
  word?: boolean;
  message: StudioPluginText;
}
/**
 * x-phasyn-extension：逐鏡檢查的角色覆蓋：subject_definitions 定義的每個 <Subject N> 都要在至少一個鏡頭的描述裡被點名，否則不能渲染（每個沒有出場的角色回報一次）。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioPluginSubjectCheck".
 */
export interface StudioPluginSubjectCheck {
  id: string;
  message: StudioPluginText;
}
/**
 * x-phasyn-extension：規則的逐鏡檢查（每個 [Shot N] 鏡頭的描述分開檢查，不是整份 prompt）：forbid 的項目命中任何一個鏡頭就不能渲染；require 的每一項都要在每一個點名 <Subject N> 的鏡頭命中；every_subject 要求 subject_definitions 的每個 <Subject N> 都在某個鏡頭被點名。比對方式與整份 prompt 的 forbid／require 相同；鏡頭怎麼切、台詞 <d>…</d> 不算在內等規則「Evaluating rules」。每個結果都帶著鏡頭編號（shot）或角色編號（subject）。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioPluginShotChecks".
 */
export interface StudioPluginShotChecks {
  /**
   * @maxItems 32
   */
  forbid?: (StudioPluginForbidPattern | StudioPluginForbidTerms)[];
  /**
   * @maxItems 32
   */
  require?: (StudioPluginRequirePattern | StudioPluginRequireTerms)[];
  every_subject?: StudioPluginSubjectCheck;
}
/**
 * x-phasyn-extension：插件的規則型貢獻：constraint（限制）、style（風格，同一 group 只能選一個）或 effect（效果）。渲染前套用到每個鏡頭的 prompt：forbid 命中或 require 沒命中就不能渲染；shots 是逐鏡（[Shot N]）的同類檢查；inject 加在 detailed_description 開頭（沒有這個欄位時加在最前面），prompt 已含同一段就不重複加。H3 沒有負向 prompt，inject 一律寫正向描述。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioPluginRule".
 */
export interface StudioPluginRule {
  id: string;
  kind: "constraint" | "style" | "effect";
  /**
   * 同一組的規則同時只能選一個（跨插件共用，例如 style）。
   */
  group?: string;
  label: StudioPluginLabel;
  description?: StudioPluginText;
  /**
   * @maxItems 32
   */
  forbid?: (StudioPluginForbidPattern | StudioPluginForbidTerms)[];
  /**
   * @maxItems 32
   */
  require?: (StudioPluginRequirePattern | StudioPluginRequireTerms)[];
  shots?: StudioPluginShotChecks;
  /**
   * 加進 prompt 的文字（≤ 2000 字）；一個專案選用的規則合計不得超過登錄表 limits.max_project_inject_bytes。
   */
  inject?: string;
}
/**
 * x-phasyn-extension：推薦組合：一鍵選用的一組規則。rules 的每一項是這個包自己的規則 id；沒有同名規則時是內建包的規則 id。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioPluginPreset".
 */
export interface StudioPluginPreset {
  id: string;
  label: StudioPluginLabel;
  description?: StudioPluginText;
  /**
   * @minItems 1
   * @maxItems 8
   */
  rules: string[];
}
/**
 * x-phasyn-extension：插件的生成設定：defaults 只在使用者按「套用」時寫進專案（看得見的一次寫入，渲染時不會偷偷套用）；require 在專案選用這個生成設定時於渲染規劃檢查。frames 必須是 17n+5，寬高必須是 32 的倍數。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioPluginGeneration".
 */
export interface StudioPluginGeneration {
  id: string;
  label: StudioPluginLabel;
  description?: StudioPluginText;
  defaults?: {
    format?: {
      width: number;
      height: number;
    };
    frames?: number;
    steps?: number;
    video_shift?: number;
    audio_shift?: number;
  };
  /**
   * @maxItems 16
   */
  require?: StudioPluginGenerationRequirement[];
  /**
   * Applies legacy H3 lattice and duration validation to this generation preset.
   */
  frame_model?: "h3";
}
/**
 * x-phasyn-extension：插件的指令（程式碼貢獻，需要 main）。這個版本只保存與顯示宣告，不執行。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioPluginCommand".
 */
export interface StudioPluginCommand {
  id: string;
  title: StudioPluginLabel;
  scope: "project" | "shot" | "clip";
}
/**
 * x-phasyn-extension：插件的面板（程式碼貢獻，需要 main）。這個版本只保存與顯示宣告，不執行。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioPluginPanel".
 */
export interface StudioPluginPanel {
  id: string;
  title: StudioPluginLabel;
  location: "generate.inspector" | "edit.dock";
}
/**
 * x-phasyn-extension：插件包的 manifest（.phasynplugin 壓縮檔根目錄的 plugin.json，≤ 128 KiB）。未知欄位一律拒絕。語意規則（schema 之外）：phasyn. 開頭的 id 只給內建包；正規表示式只有內建包可用；main 與 engines.plugin_api 必須同時出現，commands、panels 與 permissions 需要 main；規則與生成設定的 id 在同一個包內不得重複；一條規則的檢查（forbid、require 與 shots 的各項）的 id 不得重複；integrity.files 必須正好列出 plugin.json 以外的每個檔案；engines.phasyn 的下限必須小於上限；影格數必須是 17n+5；文字不得含控制字元（tab 與換行除外）、看不見的格式字元、私用區字元與 U+2028／U+2029；plugin.json 是嚴格的 JSON（UTF-8、沒有 BOM、沒有重複的鍵、巢狀最多 32 層）。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioPluginManifest".
 */
export interface StudioPluginManifest {
  manifest_version: 1;
  id: StudioPluginId;
  /**
   * 插件自己的版本（SemVer 2.0，不含 build metadata）。
   */
  version: string;
  name: StudioPluginLabel;
  description?: StudioPluginText;
  author?: {
    name: string;
    /**
     * 只接受 https://；介面以文字顯示，不做成連結。
     */
    url?: string;
  };
  license?: string;
  engines: {
    /**
     * 相容的 Phasyn Studio 版本範圍，只支援「>=a.b.c <x.y.z」。
     */
    phasyn: string;
    /**
     * 沙箱 API 的主版號；有 main 時必填，沒有 main 時不可出現。
     */
    plugin_api?: number;
  };
  /**
   * 程式碼需要的能力（project:read、project:write、timeline:write、media:read、media:write、render:start、export:start、engine:read、storage）。權限限制的是程式碼，不是人；不認得的名稱與保留名稱（network:*、ui:html）＝不相容。
   *
   * @maxItems 16
   */
  permissions?: string[];
  /**
   * 程式碼入口（單一打包檔）。這個版本不執行也不提供程式碼：含 main 的包可以安裝與檢視，狀態是不相容。
   */
  main?: "main.js";
  contributes?: {
    /**
     * @maxItems 64
     */
    rules?: StudioPluginRule[];
    /**
     * @maxItems 32
     */
    presets?: StudioPluginPreset[];
    /**
     * @maxItems 32
     */
    generation?: StudioPluginGeneration[];
    /**
     * @maxItems 64
     */
    commands?: StudioPluginCommand[];
    /**
     * @maxItems 16
     */
    panels?: StudioPluginPanel[];
  };
  integrity: {
    algorithm: "sha256";
    /**
     * plugin.json 以外每個檔案的 SHA-256（鍵是包內的相對路徑）。
     */
    files: {
      [k: string]: string | undefined;
    };
  };
}
/**
 * x-phasyn-extension：插件包的一個問題：安裝被拒絕的原因（Error.details.errors，最多 20 項）、不相容或損壞的原因、登錄表層級的問題。code 是穩定的小寫識別字，介面依 code 顯示自己的說法；message 是繁體中文的固定說明；path 是包內的相對路徑或 manifest 內的位置，從不是主機上的絕對路徑。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioPluginIssue".
 */
export interface StudioPluginIssue {
  code: string;
  message: string;
  path: string | null;
  details: {
    [k: string]: unknown | undefined;
  };
}
/**
 * x-phasyn-extension：插件包內的一個檔案（plugin.json 除外）。media_type 是 GET …/files/{path} 回應的型別：驗過檔頭的點陣圖是 image/png、image/jpeg 或 image/webp，其餘一律 application/octet-stream。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioPluginFile".
 */
export interface StudioPluginFile {
  path: string;
  size_bytes: number;
  sha256: string;
  media_type: "application/octet-stream" | "image/png" | "image/jpeg" | "image/webp";
}
/**
 * x-phasyn-extension：登錄表裡的一條規則：ref 是專案引用它的寫法，rev 是規則內容（kind、group、比對條件（含逐鏡檢查 shots）與 inject，不含顯示文字）的雜湊前 12 碼；沒有逐鏡檢查的規則的 rev 與加入 shots 之前相同。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioPluginRuleEntry".
 */
export interface StudioPluginRuleEntry {
  ref: StudioPluginRef;
  rev: string;
  rule: StudioPluginRule;
}
/**
 * x-phasyn-extension：登錄表裡的一個推薦組合：refs 是 preset.rules 解析後的引用（同順序；解析不到的規則不在其中，這時這個包的狀態是不相容）。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioPluginPresetEntry".
 */
export interface StudioPluginPresetEntry {
  preset: StudioPluginPreset;
  /**
   * @maxItems 8
   */
  refs: StudioPluginRef[];
}
/**
 * x-phasyn-extension：登錄表裡的一個生成設定：ref 是專案引用它的寫法，rev 是 defaults 與 require 條件的雜湊前 12 碼。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioPluginGenerationEntry".
 */
export interface StudioPluginGenerationEntry {
  ref: StudioPluginRef;
  rev: string;
  generation: StudioPluginGeneration;
}
/**
 * x-phasyn-extension：主控登錄表裡的一個插件包。source：builtin（隨主程式提供，唯讀、不可移除）、installed（經 API 安裝在主控的 data_dir）、dev（設定檔 plugins.dev_dirs 的目錄）。status：ok、disabled（全域停用）、incompatible（problems 說明原因）、invalid（包的內容讀不到或不再合法）；只有 ok 的包的貢獻可以套用，其餘狀態下選用它的專案不能渲染。revision 用於 PATCH 的樂觀並行（內建與開發包為 0）。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioPlugin".
 */
export interface StudioPlugin {
  plugin_id: StudioPluginId;
  source: "builtin" | "installed" | "dev";
  status: "ok" | "disabled" | "incompatible" | "invalid";
  disabled: boolean;
  /**
   * @maxItems 20
   */
  problems: StudioPluginIssue[];
  version: string | null;
  name: StudioPluginLabel;
  description: StudioPluginText | null;
  author: {
    name: string;
    url: string | null;
  } | null;
  license: string | null;
  engines: {
    phasyn: string;
    plugin_api: number | null;
  } | null;
  /**
   * @maxItems 16
   */
  permissions: string[];
  /**
   * 包內有程式碼（manifest.main）。這個版本不執行也不提供程式碼。
   */
  has_code: boolean;
  digest: string | null;
  revision: number;
  size_bytes: number;
  file_count: number;
  installed_at: string | null;
  updated_at: string | null;
  contributes: {
    /**
     * @maxItems 64
     */
    rules: StudioPluginRuleEntry[];
    /**
     * @maxItems 32
     */
    presets: StudioPluginPresetEntry[];
    /**
     * @maxItems 32
     */
    generation: StudioPluginGenerationEntry[];
    /**
     * @maxItems 64
     */
    commands: StudioPluginCommand[];
    /**
     * @maxItems 16
     */
    panels: StudioPluginPanel[];
  };
}
/**
 * x-phasyn-extension：插件包與規則的上限（安裝時檢查；介面與評估器直接讀這裡，不另外寫死）。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioPluginLimits".
 */
export interface StudioPluginLimits {
  max_package_bytes: number;
  max_files: number;
  max_file_bytes: number;
  max_unpacked_bytes: number;
  max_manifest_bytes: number;
  max_main_bytes: number;
  max_compression_ratio: number;
  max_path_depth: number;
  max_path_length: number;
  max_packages: number;
  max_total_bytes: number;
  max_project_plugins: number;
  max_inject_chars: number;
  max_project_inject_bytes: number;
  /**
   * @maxItems 32
   */
  file_extensions: string[];
}
/**
 * x-phasyn-extension：主控的插件登錄表（GET /api/studio/plugins）：Studio 與代理工具的規則評估器都讀這一份。讀不到登錄表時，選了插件貢獻的專案不能渲染。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioPluginList".
 */
export interface StudioPluginList {
  /**
   * 順序：內建包、已安裝的包、開發包，各自依 plugin_id 排序。
   *
   * @maxItems 128
   */
  items: StudioPlugin[];
  limits: StudioPluginLimits;
  host: {
    /**
     * 主程式版本（engines.phasyn 比對的對象）。
     */
    version: string;
    manifest_version: 1;
    /**
     * 這個版本能執行的沙箱 API 主版號；空陣列＝不執行程式碼。
     *
     * @maxItems 16
     */
    plugin_api: number[];
  };
  /**
   * 主控設定檔的 plugins.install：disabled 時 API 不接受安裝與移除。
   */
  install: "api" | "disabled";
  /**
   * 登錄表層級的問題（例如無法載入的開發目錄、讀不到的安裝紀錄）。
   *
   * @maxItems 20
   */
  problems: StudioPluginIssue[];
}
/**
 * x-phasyn-extension：一個插件包的完整內容（GET /api/studio/plugins/{plugin_id}）。manifest 是包內 plugin.json 的內容（status 為 invalid 而讀不到時是 null）；consent 是安裝時的紀錄（內建與開發包為 null）。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioPluginDetail".
 */
export interface StudioPluginDetail {
  plugin: StudioPlugin;
  manifest: StudioPluginManifest | null;
  /**
   * @maxItems 255
   */
  files: StudioPluginFile[];
  consent: {
    digest: string;
    /**
     * @maxItems 16
     */
    permissions: string[];
    at: string;
  } | null;
}
/**
 * x-phasyn-extension：POST /api/studio/plugins 的結果。dry_run=true 時只驗證、不安裝（detail 是安裝後會有的內容）；replaces 是同 id 目前安裝的版本（沒有時為 null）；permissions_added 是相對於它多出來的權限。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioPluginInstallResult".
 */
export interface StudioPluginInstallResult {
  dry_run: boolean;
  detail: StudioPluginDetail;
  replaces: {
    version: string;
    digest: string;
  } | null;
  /**
   * @maxItems 16
   */
  permissions_added: string[];
}
/**
 * x-phasyn-extension：PATCH /api/studio/plugins/{plugin_id} 的本文：全域停用或啟用一個已安裝的包。expected_revision 必須等於目前的 revision，否則回 409 REVISION_CONFLICT。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioPluginPatch".
 */
export interface StudioPluginPatch {
  disabled: boolean;
  expected_revision: number;
}
/**
 * x-phasyn-extension：一個專案對某個插件包的引用（專案文件的 prompt_plugins）。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioPluginProjectUse".
 */
export interface StudioPluginProjectUse {
  project_id: string;
  title: string;
  /**
   * @maxItems 8
   */
  refs: StudioPluginRef[];
}
/**
 * x-phasyn-extension：移除一個插件包的影響範圍（GET …/removal-preview，不改任何東西）。projects 是還在引用它的專案；移除不會修改專案文件，引用會保留並顯示為找不到，那些專案在移除引用或重新安裝之前不能渲染。can_remove=false 時 blocking 說明原因。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioPluginRemovalPreview".
 */
export interface StudioPluginRemovalPreview {
  plugin_id: StudioPluginId;
  version: string | null;
  digest: string | null;
  can_remove: boolean;
  /**
   * @maxItems 20
   */
  blocking: StudioPluginIssue[];
  projects: StudioPluginProjectUse[];
}
/**
 * x-phasyn-extension：DELETE /api/studio/plugins/{plugin_id} 的結果：projects 是仍然引用這個包的專案（文件沒有被修改）。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioPluginRemoval".
 */
export interface StudioPluginRemoval {
  plugin_id: StudioPluginId;
  removed: true;
  version: string | null;
  digest: string | null;
  projects: StudioPluginProjectUse[];
}
/**
 * x-phasyn-extension：只改 instance 的顯示名稱、分類資料夾、自動啟動、載入方式（load_policy／idle_unload_seconds）與使用上限；任何狀態都可改，不影響已載入的模型。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "ComponentMetaPatch".
 */
export interface ComponentMetaPatch {
  label?: string;
  folder?: ComponentFolder | null;
  autostart?: boolean;
  load_policy?: LoadPolicy1;
  /**
   * 閒置卸載秒數；null＝從元件定義移除（回到預設 600 秒）
   */
  idle_unload_seconds?: number | null;
  /**
   * 使用上限（object，序列化後 ≤ 16 KiB）；null＝從元件定義移除
   */
  limits?: {
    [k: string]: unknown | undefined;
  } | null;
}
/**
 * x-phasyn-extension：元件組合的一個分類。name 去除前後空白後 1–60 字、單行、不分大小寫不可與其他分類重複；pipeline_ids 依顯示順序。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "PipelineLayoutGroup".
 */
export interface PipelineLayoutGroup {
  group_id: string;
  name: string;
  pipeline_ids: string[];
}
/**
 * x-phasyn-extension：元件組合的分類與排序（主控 data_dir/config/pipeline-layout.json；revision 樂觀並行，從未保存為 0）。只決定顯示順序，不修改 Pipeline：groups 依序、組內 pipeline_ids 依序，然後 ungrouped；每個 pipeline_id 在 groups 與 ungrouped 中最多出現一次。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "PipelineLayout".
 */
export interface PipelineLayout {
  revision: number;
  updated_at: string | null;
  /**
   * @maxItems 200
   */
  groups: PipelineLayoutGroup[];
  ungrouped: string[];
}
/**
 * x-phasyn-extension：場景的一筆視覺證據；只屬於一個區段，view_id 指實際送進 vision 的視圖。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "PromptObservation".
 */
export interface PromptObservation {
  id: string;
  view_id: "v-full" | "v-crop-1" | "v-crop-2";
  section: PromptSectionKey;
  claim_en: string;
  certainty: "observed" | "uncertain";
}
/**
 * x-phasyn-extension：場景的一個區段：生成文字（text_en／text_zh_tw）、證據說明（explanation_zh_tw，不可代替生成文字）、同區段的 observation id 與鎖定旗標（自動修訂必須逐字保留鎖定區段）。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "PromptSceneSection".
 */
export interface PromptSceneSection {
  text_en: string;
  text_zh_tw: string;
  explanation_zh_tw: string;
  /**
   * @maxItems 40
   */
  observation_ids: string[];
  locked: boolean;
}
/**
 * x-phasyn-extension：type_id prompt.scene.v1：八區段可編輯場景（scene schema v1）。語意檢查（observation 引用同區段、subject 非空、uncertain 不可寫成肯定句）由 phasyn_qimg.prompting 執行。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "PromptScene".
 */
export interface PromptScene {
  schema_version: 1;
  prompt_language: PromptLanguage;
  sections: {
    subject: PromptSceneSection;
    action: PromptSceneSection;
    composition: PromptSceneSection;
    environment: PromptSceneSection;
    lighting: PromptSceneSection;
    appearance: PromptSceneSection;
    style: PromptSceneSection;
    visible_text: PromptSceneSection;
  };
  /**
   * @minItems 1
   * @maxItems 80
   */
  observations: PromptObservation[];
  /**
   * @maxItems 20
   */
  uncertainty_notes: string[];
}
/**
 * x-phasyn-extension：分析用裁切（正規化座標，x0<x1、y0<y1，實際像素至少 32×32）；裁切是同一張原圖的局部，不是新物件。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "PromptCrop".
 */
export interface PromptCrop {
  view_id: "v-crop-1" | "v-crop-2";
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
/**
 * x-phasyn-extension：一個編譯出的 prompt 候選。token 數只在真正生成時由 qimg.conditioning 檢查（超過上限 422，不截斷）；CPU 編譯時 token_status=unchecked、target_tokens=null 並附原因。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "PromptCandidate".
 */
export interface PromptCandidate {
  variant: "core" | "detailed";
  prompt: string;
  prompt_sha256: string;
  /**
   * @maxItems 8
   */
  sections: PromptSectionKey[];
  token_status: "unchecked" | "verified" | "too_long";
  target_tokens: number | null;
  token_reason: string | null;
}
/**
 * x-phasyn-extension：type_id prompt.candidates.v1：prompt.scene_compile 的確定性輸出（core＝subject/action/composition/style/visible_text＋鎖定與有意修改的區段；detailed＝全部非空區段；同內容時 identical=true，生成端去重）。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "PromptCandidates".
 */
export interface PromptCandidates {
  compiler_version: "prompt-compiler/1";
  compiler_sha256: string;
  language: PromptLanguage;
  scene_sha256: string;
  /**
   * @maxItems 8
   */
  intentional_changes: PromptSectionKey[];
  identical: boolean;
  /**
   * @minItems 2
   * @maxItems 2
   */
  items: PromptCandidate[];
}
/**
 * x-phasyn-extension：一個區段的比較判定（match/minor/major/missing/uncertain/not_applicable）與繁中證據說明。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "PromptMetric".
 */
export interface PromptMetric {
  label: "match" | "minor" | "major" | "missing" | "uncertain" | "not_applicable";
  evidence_zh_tw: string;
}
/**
 * x-phasyn-extension：一個可修正的可見差異：繁中描述與英文建議修改。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "PromptDifference".
 */
export interface PromptDifference {
  section: PromptSectionKey;
  description_zh_tw: string;
  suggested_change_en: string;
}
/**
 * x-phasyn-extension：type_id prompt.comparison.v1：原圖 v-full 與生成圖 v-generated 的逐區段比較；不是相似百分比。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "PromptComparison".
 */
export interface PromptComparison {
  schema_version: 1;
  sections: {
    subject: PromptMetric;
    action: PromptMetric;
    composition: PromptMetric;
    environment: PromptMetric;
    lighting: PromptMetric;
    appearance: PromptMetric;
    style: PromptMetric;
    visible_text: PromptMetric;
  };
  /**
   * @maxItems 16
   */
  unexpected_elements: string[];
  /**
   * @maxItems 16
   */
  differences: PromptDifference[];
  text_transcription: string;
  unjudgeable_reason: string | null;
}
/**
 * x-phasyn-extension：type_id prompt.pairwise.v1：同一凍結場景下 v-A 與 v-B 哪個較忠於原圖（不是哪個較好看）。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "PromptPairwise".
 */
export interface PromptPairwise {
  winner: "A" | "B" | "tie" | "uncertain";
  reason_zh_tw: string;
  /**
   * @maxItems 8
   */
  violated_sections: PromptSectionKey[];
}
/**
 * x-phasyn-extension：一次模型生成（第 2 次只會是同一個 invoke 內的格式修復）。原始輸出全文寫在 recording log，這裡保留 SHA-256、長度、token 數與驗證錯誤。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "PromptVisionAttempt".
 */
export interface PromptVisionAttempt {
  attempt: number;
  raw_sha256: string;
  raw_chars: number;
  input_tokens: number;
  output_tokens: number;
  finish_reason: "stop" | "length";
  valid: boolean;
  /**
   * @maxItems 8
   */
  errors: string[];
  repair_input_mode: ("full" | "omitted_previous_output") | null;
  elapsed_ms: number | null;
}
/**
 * x-phasyn-extension：實際送進模型的一個視圖（正規化後尺寸與處理器實際像素；crop 為 null 表示整張圖；原檔格式、是否有透明區（已合成白底）與內嵌色彩描述檔（已轉 sRGB））。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "PromptVisionView".
 */
export interface PromptVisionView {
  view_id: "v-full" | "v-crop-1" | "v-crop-2" | "v-generated" | "v-A" | "v-B";
  port: "image" | "generated" | "candidate_a" | "candidate_b";
  sha256: string;
  crop: PromptCrop | null;
  width: number;
  height: number;
  effective_width: number | null;
  effective_height: number | null;
  source_format: "PNG" | "JPEG" | "WEBP";
  had_alpha: boolean;
  had_icc_profile: boolean;
}
/**
 * x-phasyn-extension：type_id prompt.vision.result.v1：qimg.vision 一次 op 的完整結果（恰好一個結果欄位非 null）、每次嘗試（最多一次修復）、provenance 與容量預檢報告。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "PromptVisionResult".
 */
export interface PromptVisionResult {
  op: "caption" | "analyze" | "revise" | "compare" | "pairwise";
  language: PromptLanguage;
  output_format:
    "plain-caption/1" | "scene-draft/1" | "inline-scene/1" | "comparison/1" | "flat-comparison/1" | "pairwise/1";
  /**
   * @minItems 1
   * @maxItems 3
   */
  views: PromptVisionView[];
  caption: string | null;
  scene: PromptScene | null;
  comparison: PromptComparison | null;
  pairwise: PromptPairwise | null;
  /**
   * @minItems 1
   * @maxItems 2
   */
  attempts: PromptVisionAttempt[];
  provenance: {
    [k: string]: unknown | undefined;
  };
  capacity: {
    [k: string]: unknown | undefined;
  };
}
/**
 * x-phasyn-extension：凍結評分基準：任務開始時的場景（不是修訂後的場景）＋有意修改；適用區段來自原圖非空區段。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "PromptRubric".
 */
export interface PromptRubric {
  sha256: string;
  scene_sha256: string;
  /**
   * @maxItems 8
   */
  intentional_changes: PromptSectionKey[];
  /**
   * @minItems 1
   * @maxItems 8
   */
  applicable_sections: PromptSectionKey[];
}
/**
 * x-phasyn-extension：一個區段的加權損失明細；penalty 為 null 表示 uncertain／not_applicable（不計分，降低可判斷權重）。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "PromptSectionScore".
 */
export interface PromptSectionScore {
  label: "match" | "minor" | "major" | "missing" | "uncertain" | "not_applicable";
  weight: number;
  applicable: boolean;
  intentional: boolean;
  penalty: number | null;
  weighted_penalty: number | null;
}
/**
 * x-phasyn-extension：type_id prompt.score.v1：prompt.scene_score（op=loss）的加權逐區段損失（0..3）；可判斷權重 <0.75 或模型宣告無法判斷時 unverified=true、loss=null（不是 0）。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "PromptScore".
 */
export interface PromptScore {
  scorer_version: "prompt-score/1";
  rubric: PromptRubric;
  loss: number | null;
  evaluable_weight_fraction: number;
  unverified: boolean;
  /**
   * @maxItems 8
   */
  unverified_reasons: string[];
  sections: {
    subject: PromptSectionScore;
    action: PromptSectionScore;
    composition: PromptSectionScore;
    environment: PromptSectionScore;
    lighting: PromptSectionScore;
    appearance: PromptSectionScore;
    style: PromptSectionScore;
    visible_text: PromptSectionScore;
  };
}
/**
 * x-phasyn-extension：排名用的一筆評估（同一任務、同一 rubric）。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "PromptEvaluationRow".
 */
export interface PromptEvaluationRow {
  version_id: string;
  version_number: number;
  variant: "core" | "detailed";
  seed: number;
  split: "search" | "holdout" | "manual";
  loss: number | null;
  unverified: boolean;
  rubric_sha256: string;
}
/**
 * x-phasyn-extension：type_id prompt.evaluations.v1：prompt.scene_score op=rank 的輸入（共同搜尋 seeds；可選 incumbent／challenger）。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "PromptEvaluationSet".
 */
export interface PromptEvaluationSet {
  /**
   * @minItems 1
   * @maxItems 4
   */
  search_seeds: number[];
  rubric_sha256: string;
  /**
   * @maxItems 512
   */
  items: PromptEvaluationRow[];
  incumbent: {
    version_id: string;
    variant: "core" | "detailed";
  } | null;
  challenger: {
    version_id: string;
    variant: "core" | "detailed";
  } | null;
}
/**
 * x-phasyn-extension：type_id prompt.ranking.v1：不完整／未驗證／不同 rubric 的評估不能獲勝；改善門檻 0.05；代表圖取最接近平均損失的共同 seed。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "PromptRanking".
 */
export interface PromptRanking {
  /**
   * @maxItems 512
   */
  ranked: {
    version_id: string;
    version_number: number;
    variant: "core" | "detailed";
    mean_loss: number | null;
    complete: boolean;
    seeds: number[];
  }[];
  initial: {
    version_id: string;
    variant: "core" | "detailed";
  } | null;
  initial_reason: string | null;
  improvement: {
    eligible: boolean;
    delta: number | null;
    threshold: 0.05;
    reason: string | null;
    representative_pair: {
      seed: number;
      incumbent_seed: number;
      challenger_seed: number;
    } | null;
  } | null;
}
/**
 * x-phasyn-extension：type_id prompt.confirmation.v1：A/B 與 B/A 雙順序確認；第一次 A＝現任、B＝挑戰者，第二次交換圖片。只有兩次都選挑戰者才確認，平手或不確定一律不確認。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "PromptConfirmation".
 */
export interface PromptConfirmation {
  confirmed: boolean;
  /**
   * @minItems 2
   * @maxItems 2
   */
  winners: ("A" | "B" | "tie" | "uncertain")[];
  /**
   * @minItems 2
   * @maxItems 2
   */
  expected: ("A" | "B")[];
  challenger_first: boolean;
}
/**
 * x-phasyn-extension：版本來源：vision（分析／修訂 run）或 manual（使用者編輯；沿用模型身分但沒有推論）。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "PromptVersionProvenance".
 */
export interface PromptVersionProvenance {
  kind: "vision" | "manual";
  task_id: string | null;
  /**
   * @maxItems 16
   */
  run_ids: string[];
  vision: {
    [k: string]: unknown | undefined;
  } | null;
  compile: {
    [k: string]: unknown | undefined;
  } | null;
}
/**
 * x-phasyn-extension：不可變的場景版本（append-only；保存後不可修改或刪除）。candidates 必須是這個 scene 的編譯結果（scene_sha256 相符）。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "PromptStudyVersion".
 */
export interface PromptStudyVersion {
  version_id: string;
  number: number;
  parent_version_id: string | null;
  origin: "analysis" | "manual" | "refinement";
  scene: PromptScene;
  /**
   * @maxItems 8
   */
  intentional_changes: PromptSectionKey[];
  candidates: PromptCandidates;
  provenance: PromptVersionProvenance;
  note: string;
  created_at: string;
}
/**
 * x-phasyn-extension：前端逐步執行的任務紀錄（沒有背景執行、不恢復、不自動重試）。終態（succeeded/failed/cancelled/interrupted）保存後不可再修改；瀏覽器關閉留下的 running 由使用者明確標記為 interrupted。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "PromptStudyTask".
 */
export interface PromptStudyTask {
  task_id: string;
  kind: "analyze" | "refine" | "render" | "reconstruct";
  state: "running" | "succeeded" | "failed" | "cancelled" | "interrupted";
  phase: ("caption" | "analyze" | "compile" | "revise" | "render" | "compare" | "pairwise" | "holdout" | "done") | null;
  stop_reason:
    | (
        | "completed"
        | "no_improvement"
        | "budget"
        | "deadline"
        | "user_cancel"
        | "dependency_failed"
        | "invalid_output"
        | "interrupted"
      )
    | null;
  base_version_id: string | null;
  request: PromptTaskRequest;
  rubric: PromptRubric | null;
  /**
   * @maxItems 512
   */
  run_ids: string[];
  /**
   * @maxItems 512
   */
  result_refs: PromptTaskResult[];
  best: {
    version_id: string;
    variant: "core" | "detailed";
  } | null;
  verification: "analysis_only" | "rendered" | "search_evaluated" | "holdout_evaluated";
  error: ApiErrorBody | null;
  message: string;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}
/**
 * x-phasyn-extension：研究的分析原圖（建立後不可更換）。library_item 表示來自 Studio 專案素材庫（共用，不會被研究刪除）。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "PromptStudySource".
 */
export interface PromptStudySource {
  file: FileRef;
  name: string;
  width: number | null;
  height: number | null;
  library_item: {
    project_id: string;
    item_id: string;
  } | null;
}
/**
 * x-phasyn-extension：使用者明確接受的候選（只能是已結束任務中實際生成成功的候選；不覆寫機器最佳候選）。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "PromptAcceptance".
 */
export interface PromptAcceptance {
  variant: "core" | "detailed";
  task_id: string;
  run_id: string | null;
  note: string;
  accepted_at: string;
}
/**
 * x-phasyn-extension：推理 Studio 圖片反推研究（主控 data_dir/config/prompt-studies）；revision 樂觀並行（新研究為 0），不符回 409 REVISION_CONFLICT。版本 append-only、終態任務不可改、語言與原圖不可換。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "PromptStudy".
 */
export interface PromptStudy {
  study_id: string;
  title: string;
  revision: number;
  created_at: string;
  updated_at: string;
  language: PromptLanguage;
  source: PromptStudySource;
  /**
   * @maxItems 2
   */
  crops: PromptCrop[];
  settings: {
    [k: string]: unknown | undefined;
  };
  /**
   * @maxItems 1000
   */
  versions: PromptStudyVersion[];
  /**
   * @maxItems 500
   */
  tasks: PromptStudyTask[];
  accepted_version_id: string | null;
  acceptance: PromptAcceptance | null;
  archived: boolean;
  note: string;
}
/**
 * x-phasyn-extension：研究列表的一列。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "PromptStudySummary".
 */
export interface PromptStudySummary {
  study_id: string;
  title: string;
  revision: number;
  created_at: string;
  updated_at: string;
  language: PromptLanguage;
  archived: boolean;
  source: FileRef;
  source_name: string;
  version_count: number;
  task_count: number;
  running_task_count: number;
  accepted_version_id: string | null;
}
/**
 * x-phasyn-extension：研究列表（新到舊）。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "PromptStudyList".
 */
export interface PromptStudyList {
  items: PromptStudySummary[];
}
/**
 * x-phasyn-extension：刪除研究的影響範圍（GET deletion-preview 為 dry_run；DELETE 執行後同一形狀）。keep_images 保留產生圖片的 run；all 連同此研究獨占的 run 與圖片一起刪除；其他研究或 Studio 專案仍在用的 run 一律保留（shared）。一次請求完成，沒有背景續刪；失敗時停止並在 Error.details 回報已完成的部分。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "PromptStudyDeletionPlan".
 */
export interface PromptStudyDeletionPlan {
  study_id: string;
  title: string;
  mode: "keep_images" | "all";
  revision: number;
  dry_run: boolean;
  deleted: boolean;
  can_delete: boolean;
  blocking: {
    code: string;
    message: string;
    task_id: string | null;
    run_id: string | null;
  }[];
  counts: {
    versions: number;
    tasks: number;
    evaluations: number;
    images: number;
    runs_delete: number;
    runs_keep: number;
  };
  runs: {
    run_id: string;
    role: "image" | "analysis" | "unknown";
    action: "delete" | "keep" | "shared" | "missing" | "active";
    reason: string;
    files: number;
    status: "planned" | "deleted" | "missing" | "failed" | "kept";
    message: string | null;
  }[];
  source: {
    file: FileRef;
    action: "delete" | "keep";
    reason: string;
    status: "planned" | "deleted" | "missing" | "kept" | "failed";
  };
}
/**
 * x-phasyn-extension：權重的授權（名稱、全文連結、要特別注意的條款）。下載前顯示給使用者，同意後才下載。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "WeightLicense".
 */
export interface WeightLicense {
  name: string;
  url: string;
  note: string | null;
}
/**
 * x-phasyn-extension：權重組裡一個檔案在 Node 上的狀態。present＝存在且大小與固定版本相同（只比對大小，不重算雜湊）；mismatch＝存在但大小不同（只有 replace_mismatched 才取代）；partial＝有中斷的暫存檔，下載會接著下載；missing＝不存在。link_from＝內容相同的檔案已在模型根目錄下（相對路徑），下載時重算它的雜湊，相同才以 hard link 共用。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "WeightFileStatus".
 */
export interface WeightFileStatus {
  /**
   * 相對於權重組的目的地（dest）
   */
  path: string;
  size: number;
  status: "present" | "missing" | "partial" | "mismatch";
  partial_bytes: number | null;
  link_from: string | null;
}
/**
 * x-phasyn-extension：一組來自同一個 repo commit 的權重檔（provider 的權重計畫）與它們在 Node 上的狀態。dest 是相對於元件模型根目錄（load.model_path）的目的地，"" 是根目錄本身；files_missing／bytes_missing 包含有暫存檔的檔案。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "WeightSetStatus".
 */
export interface WeightSetStatus {
  set_id: string;
  label: string;
  repo: string;
  revision: string;
  license: WeightLicense;
  dest: string;
  files_total: number;
  bytes_total: number;
  files_present: number;
  bytes_present: number;
  files_missing: number;
  bytes_missing: number;
  files_mismatch: number;
  bytes_mismatch: number;
  files_linkable: number;
  bytes_linkable: number;
  bytes_partial: number;
  /**
   * @maxItems 10000
   */
  files: WeightFileStatus[];
}
/**
 * x-phasyn-extension：Node 上的一次權重下載（背景工作；以 GET weights 輪詢）。bytes_total／bytes_done 是這次要傳輸與已收到的實際位元組數（共用的檔案不算、接著下載的暫存檔只算剩下的部分）；current.phase：verify＝重算既有檔案的雜湊以便共用、download＝下載中。失敗不自動重試；Node 重啟後不保留。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "WeightsDownloadJob".
 */
export interface WeightsDownloadJob {
  job_id: string;
  component_id: string;
  state: "running" | "succeeded" | "failed" | "cancelled";
  started_at: string;
  finished_at: string | null;
  /**
   * @maxItems 100
   */
  sets: string[];
  files_total: number;
  files_done: number;
  files_linked: number;
  bytes_total: number;
  bytes_done: number;
  current: {
    /**
     * 相對於元件的模型根目錄
     */
    path: string;
    phase: "verify" | "download";
    bytes_done: number;
    bytes_total: number;
  } | null;
  error: ApiErrorBody | null;
}
/**
 * x-phasyn-extension：元件的權重計畫與每個檔案目前的狀態（GET /api/components/{id}/weights）。sets 為空＝這個 provider 沒有可下載的權重；notes 是不能下載的需求（例如在 GPU 上建立的 sidecar、使用者自己的檔案）。source.token 只表示 Node 的環境變數是否設定了 HF_TOKEN，token 本身從不經過 API。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "WeightsView".
 */
export interface WeightsView {
  component_id: string;
  root: string | null;
  root_exists: boolean;
  /**
   * @maxItems 100
   */
  sets: WeightSetStatus[];
  /**
   * @maxItems 100
   */
  notes: string[];
  free_bytes: number | null;
  source: {
    endpoint: string;
    token: boolean;
  };
  job: WeightsDownloadJob | null;
}
/**
 * x-phasyn-extension：開始下載這個元件缺少的權重（元件須為 stopped 或 error；一個 Node 同時只有一個下載）。accept_licenses 必須是 true：使用者已看過並同意這些權重的授權。sets 省略＝計畫裡的全部權重組；replace_mismatched＝取代大小與固定版本不同的既有檔案（預設 false：有這種檔案就回 409 WEIGHTS_DESTINATION_CONFLICT）。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "WeightsDownloadRequest".
 */
export interface WeightsDownloadRequest {
  accept_licenses: true;
  /**
   * @minItems 1
   * @maxItems 100
   */
  sets?: string[];
  replace_mismatched?: boolean;
}
/**
 * append_unplaced gives every shot that has no clip its place after the last clip of the first video and audio tracks (a shot without a finished take gets a source without a file); rebuild clears those two tracks and lays out again, untrimmed and in storage order, every shot that had a clip on the timeline (needs confirm: true).
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "TimelineCommandAssemble".
 */
export interface TimelineCommandAssemble {
  op: "assemble";
  mode: "append_unplaced" | "rebuild";
  confirm?: boolean;
}
/**
 * Three-point edit of a source range [in_frame,out_frame) onto the tracks. Exactly one of shot_id, library_id and source_id names the media. video and audio default to what the source has; the tracks default to the first video and the first audio track. insert ripples every sync-locked track; overwrite trims or splits what lies underneath on the target tracks.
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "TimelineCommandPlace".
 */
export interface TimelineCommandPlace {
  op: "place";
  shot_id?: string;
  library_id?: string;
  source_id?: string;
  /**
   * Sequence frame, or end: after the last clip of the target tracks.
   */
  at?: number | "end";
  mode?: "insert" | "overwrite";
  video?: boolean;
  audio?: boolean;
  track_video?: string;
  track_audio?: string;
  in_frame?: number;
  out_frame?: number;
  expected_source_sha256?: string;
  run_id?: string;
  output_key?: string;
  /**
   * Reject placement if any target track overlaps an existing clip.
   */
  only_if_empty?: boolean;
}
/**
 * Move a selection; the first clip is the one to_frame and track_id refer to. Exactly one of to_frame and delta. overwrite trims or splits what lies underneath at the destination; insert opens the destination on every sync-locked track. The place the clips left stays empty.
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "TimelineCommandMove".
 */
export interface TimelineCommandMove {
  op: "move";
  /**
   * @minItems 1
   * @maxItems 1000
   */
  clip_ids: string[];
  to_frame?: number;
  delta?: number;
  track_id?: string;
  mode?: "overwrite" | "insert";
  /**
   * Edit linked partners together (default true).
   */
  linked?: boolean;
}
/**
 * Trim one edge to a sequence frame or by a number of frames (positive moves the edge later). ripple shifts everything after the edit on sync-locked tracks; roll moves the cut against the adjacent clip.
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "TimelineCommandTrim".
 */
export interface TimelineCommandTrim {
  op: "trim";
  clip_id: string;
  edge: "in" | "out";
  to_frame?: number;
  delta?: number;
  mode?: "normal" | "ripple" | "roll";
  /**
   * Edit linked partners together (default true).
   */
  linked?: boolean;
}
/**
 * Shift the source range under a clip by delta source frames; position and duration stay.
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "TimelineCommandSlip".
 */
export interface TimelineCommandSlip {
  op: "slip";
  clip_id: string;
  delta: number;
  /**
   * Edit linked partners together (default true).
   */
  linked?: boolean;
}
/**
 * Move a clip between its two neighbours; their adjacent edges follow.
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "TimelineCommandSlide".
 */
export interface TimelineCommandSlide {
  op: "slide";
  clip_id: string;
  delta: number;
  /**
   * Edit linked partners together (default true).
   */
  linked?: boolean;
}
/**
 * Add an edit at a sequence frame. Without clip_ids every clip on an unlocked track under the frame is split.
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "TimelineCommandSplit".
 */
export interface TimelineCommandSplit {
  op: "split";
  at_frame: number;
  /**
   * @minItems 1
   * @maxItems 1000
   */
  clip_ids?: string[];
  /**
   * Edit linked partners together (default true).
   */
  linked?: boolean;
}
/**
 * Delete clips; ripple closes the gap on sync-locked tracks.
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "TimelineCommandRemove".
 */
export interface TimelineCommandRemove {
  op: "remove";
  /**
   * @minItems 1
   * @maxItems 1000
   */
  clip_ids: string[];
  ripple?: boolean;
  /**
   * Edit linked partners together (default true).
   */
  linked?: boolean;
}
/**
 * Patch clip properties; null clears a field. A speed or hold change is applied to linked partners too.
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "TimelineCommandSetClip".
 */
export interface TimelineCommandSetClip {
  op: "set_clip";
  clip_id: string;
  name?: string;
  /**
   * Partial MediaClipEffects merged into the clip's effects (objects merge, null removes a member). transition_out is set with the transition command.
   */
  effects?: {
    [k: string]: unknown | undefined;
  } | null;
  /**
   * Partial TimelineMotion merged into the clip's motion; a keyframes channel is replaced as a whole, null removes it.
   */
  motion?: {
    [k: string]: unknown | undefined;
  };
  blend_mode?: ("normal" | "multiply" | "screen" | "add") | null;
  mask?: TimelineMask | null;
  effect_stack?: TimelineEffect[] | null;
  enabled?: boolean;
  /**
   * Edit linked partners together (default true).
   */
  linked?: boolean;
}
/**
 * Set or clear (cut) the transition from a clip into the next clip of its track. It sits on their cut by its alignment and uses the two clips' frames beyond the cut: their hidden output, then their source handles, then a freeze of the edge frame where the media runs out. No other clip moves and the sequence keeps its length; a change starts again from the cut, and cut gives both clips back as they were at the cut.
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "TimelineCommandTransition".
 */
export interface TimelineCommandTransition {
  op: "transition";
  clip_id: string;
  /**
   * fade_black and fade_white are stored as dip_to_black and dip_to_white. push, slide, whip, wipe and zoom move the pictures (see MediaClipEffects.transition_out).
   */
  kind:
    | "cut"
    | "crossfade"
    | "fade_black"
    | "fade_white"
    | "dip_to_black"
    | "dip_to_white"
    | "push"
    | "slide"
    | "whip"
    | "wipe"
    | "zoom";
  frames?: number;
  /**
   * push, slide, whip and wipe: left, right, up or down; zoom: in or out. Missing keeps the current transition's direction, or left (in for zoom).
   */
  direction?: "left" | "right" | "up" | "down" | "in" | "out";
  /**
   * The movement's progress curve for push, slide, whip, wipe and zoom. Missing keeps the current one, or ease_in_out.
   */
  easing?: "linear" | "ease_in" | "ease_out" | "ease_in_out";
  /**
   * wipe only: width of the soft edge relative to the travel. Missing keeps the current one, or 0.05.
   */
  softness?: number;
  /**
   * Where the transition sits on the cut: center (centred on it; an odd length has its extra frame after the cut), start (it begins at the cut) or end (it ends at the cut). Missing keeps the current transition's alignment, or center. Not for cut.
   */
  alignment?: "center" | "start" | "end";
  /**
   * Edit linked partners together (default true).
   */
  linked?: boolean;
}
/**
 * Add an independent text layer clip (five seconds unless duration_frames is given). Without track_id it goes on the top video track when that is free, otherwise on a new video track.
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "TimelineCommandAddText".
 */
export interface TimelineCommandAddText {
  op: "add_text";
  text: string;
  at_frame: number;
  duration_frames?: number;
  track_id?: string;
  position?: "top" | "center" | "bottom" | "lower_third";
  size?: "small" | "medium" | "large";
  font_family?: "sans" | "serif" | "mono";
  font_size?: number;
  font_weight?: 400 | 700;
  color?: string;
  align?: "left" | "center" | "right";
  x?: number;
  y?: number;
}
/**
 * Add an adjustment layer clip (five seconds unless duration_frames is given): a clip without a picture of its own whose effects change the composite of the video tracks below it. Without track_id it goes on the lowest unlocked video track above the first one and above every video track that shows something in its range, otherwise on a new video track at the top.
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "TimelineCommandAddAdjustment".
 */
export interface TimelineCommandAddAdjustment {
  op: "add_adjustment";
  at_frame: number;
  duration_frames?: number;
  track_id?: string;
  name?: string;
}
/**
 * add needs kind (name optional); remove, rename and set need track_id. A track with clips cannot be removed.
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "TimelineCommandTrack".
 */
export interface TimelineCommandTrack {
  op: "track";
  action: "add" | "remove" | "rename" | "set";
  kind?: "video" | "audio";
  track_id?: string;
  name?: string;
  locked?: boolean;
  muted?: boolean;
  solo?: boolean;
  sync_lock?: boolean;
  gain_db?: number;
  pan?: number;
  /**
   * The same fields as a nested object (accepted for convenience).
   */
  fields?: {
    name?: string;
    locked?: boolean;
    muted?: boolean;
    solo?: boolean;
    sync_lock?: boolean;
    gain_db?: number;
    pan?: number;
  };
}
/**
 * add needs frame; update and remove need marker_id.
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "TimelineCommandMarker".
 */
export interface TimelineCommandMarker {
  op: "marker";
  action: "add" | "update" | "remove";
  marker_id?: string;
  frame?: number;
  name?: string;
  color?: "blue" | "green" | "amber" | "rose" | "violet";
}
export interface TimelineCommandCaption1 {
  op: "caption";
  action: "add" | "update" | "remove" | "import_srt" | "clear" | "import_transcript";
  caption_id?: string;
  text?: string;
  start_frame?: number;
  end_frame?: number;
  position?: "top" | "center" | "bottom" | "lower_third";
  size?: "small" | "medium" | "large";
  srt?: string;
  /**
   * The same fields as a nested object (accepted for convenience).
   */
  fields?: {
    text?: string;
    start_frame?: number;
    end_frame?: number;
    position?: "top" | "center" | "bottom" | "lower_third";
    size?: "small" | "medium" | "large";
  };
  clip_id?: string;
  run_id?: string;
  output_key?: string;
}
/**
 * Set the sequence In and Out (end exclusive), or clear them with clear: true.
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "TimelineCommandWorkArea".
 */
export interface TimelineCommandWorkArea {
  op: "work_area";
  start_frame?: number;
  end_frame?: number;
  clear?: true;
}
/**
 * Set the master gain.
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "TimelineCommandMaster".
 */
export interface TimelineCommandMaster {
  op: "master";
  gain_db: number;
}
/**
 * Join Through Edits: remove the edit between a clip and the next clip of its track when both show contiguous ranges of one source with identical properties.
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "TimelineCommandJoin".
 */
export interface TimelineCommandJoin {
  op: "join";
  clip_id: string;
  /**
   * Edit linked partners together (default true).
   */
  linked?: boolean;
}
/**
 * Rearrange edit: lift clips of one track (with their linked partners) and insert them at another edit point of that track. Only the tracks of the moved clips re-flow; nothing is overwritten.
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "TimelineCommandRearrange".
 */
export interface TimelineCommandRearrange {
  op: "rearrange";
  /**
   * @minItems 1
   * @maxItems 1000
   */
  clip_ids: string[];
  to_frame: number;
  /**
   * Edit linked partners together (default true).
   */
  linked?: boolean;
}
/**
 * Apply a pending shorter take (TimelineSource.pending_take_id): clips that reach beyond the new media are ripple-trimmed to it, then the source is bound to the take. Exactly one of source_id and shot_id.
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "TimelineCommandReconcile".
 */
export interface TimelineCommandReconcile {
  op: "reconcile";
  source_id?: string;
  shot_id?: string;
}
/**
 * Enable or disable clips. A disabled clip keeps its place and is skipped by preview and export.
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "TimelineCommandSetEnabled".
 */
export interface TimelineCommandSetEnabled {
  op: "set_enabled";
  /**
   * @minItems 1
   * @maxItems 1000
   */
  clip_ids: string[];
  enabled: boolean;
  /**
   * Edit linked partners together (default true).
   */
  linked?: boolean;
}
/**
 * Apply a pinned media candidate to exactly one track over a half-open interval. fill_gap requires both bordering clips; replace_range requires continuous existing coverage. Other tracks keep their positions.
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "TimelineCommandRangeCandidate".
 */
export interface TimelineCommandRangeCandidate {
  op: "range_candidate";
  mode: "fill_gap" | "replace_range";
  track_id: string;
  start_frame: number;
  end_frame: number;
  candidate_in_frame?: number;
  expected_source_sha256: string;
  source_id?: string;
  library_id?: string;
  shot_id?: string;
  take_id?: string;
  run_id?: string;
  output_key?: string;
  inherit_static_visuals?: boolean;
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "TimelineCommandCollectOutput".
 */
export interface TimelineCommandCollectOutput {
  op: "collect_output";
  name: string;
  run_id: string;
  output_key: string;
  expected_source_sha256: string;
}
/**
 * Edits applied in order to the project's timeline, all or nothing. revision is the project revision the caller read.
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioTimelineCommandsRequest".
 */
export interface StudioTimelineCommandsRequest {
  revision: number;
  /**
   * true = validate and return the would-be document without saving.
   */
  dry_run?: boolean;
  /**
   * @minItems 1
   * @maxItems 64
   */
  commands: StudioTimelineCommand[];
}
/**
 * What one command did: the clips it created or changed, the other objects it created and a one-line summary (Traditional Chinese).
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioTimelineApplied".
 */
export interface StudioTimelineApplied {
  op: string;
  /**
   * @maxItems 1000
   */
  clip_ids: string[];
  summary: string;
  /**
   * @maxItems 16
   */
  track_ids?: string[];
  /**
   * @maxItems 500
   */
  marker_ids?: string[];
  /**
   * @maxItems 500
   */
  caption_ids?: string[];
  /**
   * @maxItems 500
   */
  source_ids?: string[];
}
/**
 * The saved project (with dry_run: the would-be document at its current revision) and one entry per command.
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioTimelineCommandsResult".
 */
export interface StudioTimelineCommandsResult {
  project: StudioProject;
  /**
   * @maxItems 64
   */
  applied: StudioTimelineApplied[];
}
/**
 * Error.details of STUDIO_TIMELINE_REJECTED: a stable reason, the index of the refused command (timeline commands only) and facts about the refusal. Nothing was saved.
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioTimelineRejection".
 */
export interface StudioTimelineRejection {
  reason:
    | "invalid_command"
    | "invalid_document"
    | "clip_not_found"
    | "track_not_found"
    | "source_not_found"
    | "shot_not_found"
    | "library_item_not_found"
    | "marker_not_found"
    | "caption_not_found"
    | "track_locked"
    | "track_kind"
    | "track_not_empty"
    | "confirm_required"
    | "not_rendered"
    | "source_unavailable"
    | "source_range"
    | "out_of_range"
    | "overlap"
    | "sync_lock_conflict"
    | "linked_mismatch"
    | "not_adjacent"
    | "not_edit_point"
    | "not_joinable"
    | "nothing_pending"
    | "transition_too_long"
    | "transition_mismatch"
    | "transition_conflict"
    | "effect_range"
    | "effect_phase"
    | "keyframes"
    | "compositing"
    | "text_invalid"
    | "text_layer"
    | "adjustment_layer"
    | "caption_range"
    | "srt_invalid"
    | "work_area"
    | "limit_exceeded"
    | "duplicate_id"
    | "reference_missing"
    | "output_window"
    | "fps"
    | "proxy"
    | "empty_timeline"
    | "text_not_rasterized"
    | "adjustment_unsupported";
  command_index?: number;
  [k: string]: unknown | undefined;
}
/**
 * Export the saved timeline with media.concat. revision is the project revision the caller read.
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioTimelineExportRequest".
 */
export interface StudioTimelineExportRequest {
  revision: number;
  range?: "full" | "work_area";
  /**
   * source = the render size. Omitted = the project's export_format when it has one, otherwise source.
   */
  size?: "source" | "720p" | "1080p";
  /**
   * fill = cover the frame and crop the edges, fit = keep the whole picture with black bars. Omitted = the project's export_format fit, otherwise fill. Not used with size source.
   */
  fit?: "fill" | "fit";
  quality?: "high" | "standard" | "small";
  speed?: "medium" | "veryfast";
  audio_kbps?: 128 | 192 | 256;
  /**
   * Integrated loudness target of the exported sound in LUFS (two-pass EBU R128 loudnorm, linear gain, true peak -1.5 dBTP, LRA 11). Absent: the mix is exported as it is, without normalisation. The measured loudness before and after is in the asset's actual_settings.concat.loudness.
   */
  loudness?: -18 | -16 | -14;
}
/**
 * The export run that was started and the project with its new StudioExport record.
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioTimelineExportResult".
 */
export interface StudioTimelineExportResult {
  run_id: string;
  export_id: string;
  project: StudioProject;
}
/**
 * One prompt statement an adherence scorer checked against the take: phrased so that yes means the take follows the prompt. n/a: the statement's shot starts after the kept frames (not scored).
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioTakeReviewStatement".
 */
export interface StudioTakeReviewStatement {
  id?: string;
  text: string;
  kind: string;
  verdict: "yes" | "no" | "unclear" | "n/a";
  p_yes?: number | null;
  /**
   * false: kept for reference, excluded from the score.
   */
  scored?: boolean;
  shot?: number | null;
  t0?: number | null;
  t1?: number | null;
  note?: string;
}
/**
 * Frames of the take (0-based, end inclusive) where a residue gate saw what should not be there.
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioTakeResidueRange".
 */
export interface StudioTakeResidueRange {
  start_frame: number;
  end_frame: number;
  who: string;
  note?: string;
}
/**
 * What one scorer found in one take. Key: (take_id, kind, source, role); a write with the same key replaces it. adherence: score (share of yes over the scored statements) and statements. residue: residue (confirmed, suspect = needs a look, clean) and ranges. created_at is when the scorer made it (the write time when not given); received_at is set by the Controller.
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioTakeReview".
 */
export interface StudioTakeReview {
  take_id: string;
  kind: "adherence" | "residue";
  source: string;
  role?: ("generated" | "shot") | null;
  score?: number | null;
  unclear_frac?: number | null;
  residue?: ("confirmed" | "suspect" | "clean") | null;
  /**
   * @maxItems 64
   */
  statements?: StudioTakeReviewStatement[];
  /**
   * @maxItems 128
   */
  ranges?: StudioTakeResidueRange[];
  note?: string;
  model?: string | null;
  version?: string | null;
  checked_by?: string | null;
  prompt_hash?: string | null;
  created_at?: string;
  received_at?: string;
}
/**
 * The take reviews of one project, kept outside the project document (writing them never changes the project's revision). revision: +1 on every write; 0 and updated_at null when none was written.
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioTakeReviews".
 */
export interface StudioTakeReviews {
  project_id: string;
  revision: number;
  updated_at: string | null;
  /**
   * @maxItems 10000
   */
  reviews: StudioTakeReview[];
}
/**
 * Reviews to add or replace (by key), all or nothing. Every take_id must be a video take of the project; a key may appear once.
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioTakeReviewsWrite".
 */
export interface StudioTakeReviewsWrite {
  /**
   * @minItems 1
   * @maxItems 1000
   */
  reviews: StudioTakeReview[];
}
/**
 * The saved reviews document; written = reviews in the request, replaced = how many of them had a stored review with the same key.
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioTakeReviewsWriteResult".
 */
export interface StudioTakeReviewsWriteResult {
  reviews: StudioTakeReviews;
  written: number;
  replaced: number;
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "CallReceipt".
 */
export interface CallReceipt {
  node_id: string;
  component_id: string;
  call_id: string;
  run_id: string | null;
  step_id: string | null;
  request_digest: string;
  phase: "running" | "finished" | "not_started" | "output_missing" | "unknown" | "stopped";
  result: InvokeResult | null;
  error: ApiErrorBody | null;
  /**
   * The owner declares that replacing a verified stopped attempt is safe for this component. Absent means no replacement.
   */
  retry_after_verified_stop?: boolean;
  provider_id?: string;
  operation_digest?: string;
  superseded_by?: string;
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioCreativeEntryWrite".
 */
export interface StudioCreativeEntryWrite {
  expected_revision: number;
  project_revision: number;
  kind: "character" | "scene";
  name: string;
  fields: {
    [k: string]: string | undefined;
  };
  /**
   * @maxItems 9
   */
  reference_items: string[];
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioCreativeBindingWrite".
 */
export interface StudioCreativeBindingWrite {
  project_revision: number;
  expected_revision: number;
  model: "h3.t2va" | "h3.ref2va" | "qimg.t2i" | "qimg.i2i" | "portable.video" | "portable.image";
  /**
   * @maxItems 24
   */
  entries: {
    entry_id: string;
    revision: number;
    overrides?: {
      [k: string]: string | undefined;
    };
  }[];
  state?: {
    [k: string]: string | undefined;
  };
  media_bindings?: StudioCreativeMediaBindings;
  /**
   * Include compiled text in the run. A portable video binding with driving media can explicitly omit it.
   */
  include_prompt?: boolean;
}
/**
 * Project library item IDs pinned to semantic inputs of a creative video plugin.
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioCreativeMediaBindings".
 */
export interface StudioCreativeMediaBindings {
  character_image?: string;
  source_audio?: string;
  performance_video?: string;
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioCreativeReference".
 */
export interface StudioCreativeReference {
  item_id: string;
  name: string;
  file: FileRef;
  source?: "entry" | "shot";
  entry_id?: string;
  revision?: number;
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioCreativeEntrySummary".
 */
export interface StudioCreativeEntrySummary {
  entry_id: string;
  revision: number;
  kind: "character" | "scene";
  name: string;
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioCreativeEntryList".
 */
export interface StudioCreativeEntryList {
  /**
   * @maxItems 500
   */
  items: StudioCreativeEntrySummary[];
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioCreativeEntryVersion".
 */
export interface StudioCreativeEntryVersion {
  project_id: string;
  project_revision: number;
  revision: number;
  digest: string;
  entry_id: string;
  kind: "character" | "scene";
  name: string;
  fields: {
    [k: string]: string | undefined;
  };
  /**
   * @maxItems 9
   */
  references: StudioCreativeReference[];
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioCreativeBindingVersion".
 */
export interface StudioCreativeBindingVersion {
  project_id: string;
  project_revision: number;
  revision: number;
  digest: string;
  model: "h3.t2va" | "h3.ref2va" | "qimg.t2i" | "qimg.i2i" | "portable.video" | "portable.image";
  medium: "video" | "image";
  shot_id: string;
  source_digest: string;
  /**
   * @maxItems 24
   */
  entries: {
    entry_id: string;
    revision: number;
    overrides?: {
      [k: string]: string | undefined;
    };
  }[];
  state: {
    [k: string]: string | undefined;
  };
  inputs: {
    [k: string]: TypedValue | undefined;
  };
  /**
   * @maxItems 9
   */
  references: StudioCreativeReference[];
  /**
   * @maxItems 1000
   */
  fragments: {
    text: string;
    source: "shot" | "entry" | "override" | "reference" | "shot_state";
    field?: string;
    entry_id?: string;
    revision?: number;
    item_id?: string;
    original?: string;
    start: number;
    end: number;
  }[];
  mask: StudioCreativeReference | null;
  reference_settings: {
    base_index?: number | null;
    mask_invert?: boolean;
    reference_resolution?: number;
    cfg?: boolean;
  };
  media_bindings?: StudioCreativeMediaBindings;
  /**
   * Include compiled text in the run. A portable video binding with driving media can explicitly omit it.
   */
  include_prompt?: boolean;
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioCreativeEntryRead".
 */
export interface StudioCreativeEntryRead {
  version: StudioCreativeEntryVersion;
  latest_revision: number;
  /**
   * @maxItems 64
   */
  review: {
    source: "shot_missing" | "shot" | "entry" | "reference" | "mask";
    entry_id?: string;
    revision?: number;
    latest_revision?: number;
    item_id?: string;
  }[];
  shot_uses?: {
    medium: "video" | "image";
    shot_id: string;
    title: string;
    binding_revision: number;
    entry_revision: number;
    active_take_id: string | null;
    affected_fields: string[];
    overridden_fields: string[];
    name_changed: boolean;
    references_changed: boolean;
  }[];
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioCreativeBindingRead".
 */
export interface StudioCreativeBindingRead {
  version: StudioCreativeBindingVersion;
  latest_revision: number;
  /**
   * @maxItems 64
   */
  review: {
    source: "shot_missing" | "shot" | "entry" | "reference" | "mask";
    entry_id?: string;
    revision?: number;
    latest_revision?: number;
    item_id?: string;
  }[];
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "InferenceRecipeExport".
 */
export interface InferenceRecipeExport {
  schema_version: "phasyn.inference-recipe.v1";
  recipe_sha256: string;
  recipe: {
    schema_version: "phasyn.inference-recipe.v1";
    pipeline_id: string | null;
    inputs: {
      [k: string]: {} | undefined;
    };
    steps: {
      [k: string]: {} | undefined;
    };
  };
  execution: {
    run_id: string;
    state: string;
    steps: {
      [k: string]: {} | undefined;
    };
    inference_preset?: InferencePresetOrigin;
  };
  document_sha256: string;
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "RecipeComparisonRun".
 */
export interface RecipeComparisonRun {
  run_id: string;
  state: string | null;
  pipeline_id: string | null;
  recipe_sha256: string;
  document_sha256: string;
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "RecipeSettingPair".
 */
export interface RecipeSettingPair {
  name: string;
  left: unknown;
  right: unknown;
  status: "equal" | "different" | "unknown" | "left_only" | "right_only";
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "RecipeMetricPair".
 */
export interface RecipeMetricPair {
  name: string;
  left: unknown;
  right: unknown;
  delta: number | null;
  reason: null | "unmeasured" | "unit" | "scope" | "method" | "provider" | "nonfinite" | "categorical";
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "RecipeComparisonStep".
 */
export interface RecipeComparisonStep {
  step_id: string;
  left_present: boolean;
  right_present: boolean;
  left_recording: string | null;
  right_recording: string | null;
  settings: RecipeSettingPair[];
  metrics: RecipeMetricPair[];
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "RecipeComparison".
 */
export interface RecipeComparison {
  schema_version: "phasyn.recipe-comparison.v1";
  left: RecipeComparisonRun;
  right: RecipeComparisonRun;
  inputs: RecipeSettingPair[];
  steps: RecipeComparisonStep[];
  attribution: "not_established";
  perceptual_quality: "not_measured";
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioCreativeRunPlan".
 */
export interface StudioCreativeRunPlan {
  request: RunRequest;
  creative_binding: {
    project_id: string;
    medium: "video" | "image";
    shot_id: string;
    revision: number;
    digest: string;
    model: "h3.t2va" | "h3.ref2va" | "qimg.t2i" | "qimg.i2i" | "portable.video" | "portable.image";
  };
  request_digest: string;
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioTakeAttachRequest".
 */
export interface StudioTakeAttachRequest {
  run_id: string;
  output_key: string;
  expected_revision: number;
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioTakeAttachResult".
 */
export interface StudioTakeAttachResult {
  project_id: string;
  shot_id: string;
  revision: number;
  created: boolean;
  take: StudioTake;
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioDraftPlanRequest".
 */
export interface StudioDraftPlanRequest {
  project_revision: number;
  pipeline_id: string;
  prompt_input: string;
  seed_step: string;
  output_key: string;
  qc_pipeline_id: string;
  qc_input: string;
  qc_output: string;
  /**
   * @minItems 1
   * @maxItems 16
   */
  shots: {
    shot_id: string;
    library_inputs?: {
      [k: string]: string | undefined;
    };
  }[];
  variants: number;
  seed: number;
  budget: {
    max_runs: number;
    max_step_attempts: number;
    timeout_seconds: number;
    max_gpu_seconds?: number;
    max_external_cost_usd_micros?: number;
  };
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioDraftApproval".
 */
export interface StudioDraftApproval {
  digest: string;
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioDraftSelection".
 */
export interface StudioDraftSelection {
  digest: string;
  candidate_id: string;
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioDraftPlan".
 */
export interface StudioDraftPlan {
  project_id: string;
  plan_id: string;
  digest: string;
  spec_digest: string;
  status: "planned" | "running" | "stopping" | "completed" | "cancelled" | "expired" | "uncertain" | "budget_exhausted";
  plan: StudioFrozenDraftPlan;
  deadline: number | null;
  reserved_runs: number;
  reserved_step_attempts: number;
  stop_reason: string | null;
  selected: {
    [k: string]: string | undefined;
  };
  /**
   * @maxItems 32
   */
  results: StudioDraftCandidateResult[];
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioFrozenDraftPlan".
 */
export interface StudioFrozenDraftPlan {
  project_id: string;
  plan_id: string;
  project_revision: number;
  project_created_at: string;
  budget: {
    max_runs: number;
    max_step_attempts: number;
    timeout_seconds: number;
    max_gpu_seconds?: number;
    max_external_cost_usd_micros?: number;
  };
  planned_runs: number;
  planned_step_attempts: number;
  components: {
    draft: {
      [k: string]: string | undefined;
    };
    qc: {
      [k: string]: string | undefined;
    };
  };
  draft_output: string;
  qc_pipeline: Pipeline;
  qc_input: string;
  qc_output: string;
  /**
   * @maxItems 32
   */
  candidates: StudioFrozenDraft[];
  reserved_gpu_seconds?: number;
  reserved_external_cost_usd_micros?: number;
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioFrozenDraft".
 */
export interface StudioFrozenDraft {
  candidate_id: string;
  shot_id: string;
  variant: number;
  seed: number;
  draft: RunRequest;
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioDraftCandidateResult".
 */
export interface StudioDraftCandidateResult {
  candidate_id: string;
  stage: "draft" | "qc";
  state: "queued" | "dispatched" | "ready" | "review" | "failed" | "skipped";
  runs: {
    draft?: StudioDraftRunReceipt;
    qc?: StudioDraftRunReceipt;
  };
  asset?: Asset;
  quality?: StudioDraftTechnicalReview;
  error?: {
    [k: string]: unknown | undefined;
  };
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioDraftRunReceipt".
 */
export interface StudioDraftRunReceipt {
  run_id: string;
  request_digest: string;
  state?: "running" | "succeeded" | "cancelled" | "interrupted" | "failed";
  cancel_requested?: boolean;
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioDraftTechnicalReview".
 */
export interface StudioDraftTechnicalReview {
  /**
   * @maxItems 16
   */
  issues: string[];
  evidence: {
    [k: string]: unknown | undefined;
  };
  output_files?: {
    [k: string]: FileRef | undefined;
  };
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioDraftPlanList".
 */
export interface StudioDraftPlanList {
  /**
   * @maxItems 100
   */
  items: {
    plan_id: string;
    status:
      "planned" | "running" | "stopping" | "completed" | "cancelled" | "expired" | "uncertain" | "budget_exhausted";
  }[];
  next_cursor: string | null;
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "PlacementRequest".
 */
export interface PlacementRequest {
  /**
   * @minItems 1
   * @maxItems 4
   */
  alternatives: {
    pipeline_id: string;
    envelope?: PlacementEnvelope;
    source_run_id?: string;
    padding_percent?: number;
  }[];
  inputs: {
    [k: string]: TypedValue | undefined;
  };
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "PlacementNodeResources".
 */
export interface PlacementNodeResources {
  node_id: string;
  sampled_at: string;
  source_revision: string;
  host: {
    total_bytes: number | null;
    available_bytes: number | null;
    cgroup_state: "unavailable" | "not_applicable" | "no_visible_limit" | "limited";
    cgroup_limit_bytes: number | null;
    cgroup_available_bytes: number | null;
  };
  devices: {
    [k: string]:
      | {
          kind: "cpu" | "cuda";
          pool: "dedicated" | "unified" | "unknown" | "host";
          total_bytes: number | null;
          available_bytes: number | null;
          utilization_pct: number | null;
          pool_id: string | null;
        }
      | undefined;
  };
  components: {
    [k: string]:
      | {
          provider_id: string;
          runtime_id: string;
          state: string;
          device_id: string;
          resource_group: string;
          busy: boolean;
          /**
           * @maxItems 16
           */
          holds: string[];
          loaded_revision: number | null;
          effective_load_digest: string | null;
        }
      | undefined;
  };
  host_pool_id: string;
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "PlacementAlternative".
 */
export interface PlacementAlternative {
  pipeline_id: string;
  state: "ready" | "waiting" | "rejected";
  signature: string | null;
  /**
   * @maxItems 300
   */
  reasons: string[];
  steps: {
    [k: string]: {} | undefined;
  };
  nodes: {
    [k: string]: {} | undefined;
  };
  envelope_basis: string | null;
  physical_pools: {
    [k: string]: {} | undefined;
  };
  input_shapes: {
    [k: string]: {} | undefined;
  };
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "PlacementPreview".
 */
export interface PlacementPreview {
  /**
   * @maxItems 4
   */
  alternatives: PlacementAlternative[];
  selected: string | null;
  run_request: RunRequest | null;
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "InferencePresetCapture".
 */
export interface InferencePresetCapture {
  expected_revision: number;
  label: string;
  source_run_id: string;
  task: "t2va" | "fl2va" | "ref2va" | "t2i" | "i2i";
  parameters?: {
    steps?: number;
    seed?: number;
    guidance?: number;
    video_shift?: number;
    audio_shift?: number;
    sigma_schedule?: "native" | "karras" | "exponential";
    flow_shift_mu?: number | null;
  };
  /**
   * @maxItems 8
   */
  adapter_roles?: ("style" | "control" | "acceleration" | "unspecified")[];
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "InferencePresetResolve".
 */
export interface InferencePresetResolve {
  revision: number;
  inputs: {
    [k: string]: TypedValue | undefined;
  };
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "InferencePresetSubmit".
 */
export interface InferencePresetSubmit {
  revision: number;
  inputs: {
    [k: string]: TypedValue | undefined;
  };
  request_id: string;
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "InferencePresetPolicy".
 */
export interface InferencePresetPolicy {
  provider: "h3.dit" | "qimg.dit";
  step_id: string;
  task: "t2va" | "fl2va" | "ref2va" | "t2i" | "i2i";
  variant: string;
  parameters: {
    [k: string]: unknown | undefined;
  };
  scheduler: string;
  adapters: {
    [k: string]: unknown | undefined;
  }[];
  precision: {} | null;
  part_overrides: {
    [k: string]: unknown | undefined;
  }[];
  requested_attention: unknown;
  recorded_attention: {
    [k: string]: unknown | undefined;
  };
  model_identity: {
    [k: string]: unknown | undefined;
  };
  runtime: {
    [k: string]: unknown | undefined;
  };
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "InferencePresetList".
 */
export interface InferencePresetList {
  items: {
    id: string;
    revision: number;
    label: string;
    stamp: string;
  }[];
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "InferencePresetRevision".
 */
export interface InferencePresetRevision {
  preset_id: string;
  revision: number;
  created_at: string;
  definition_sha256: string;
  source_recipe_sha256: string;
  source_run_id: string;
  schema_version: "phasyn.inference-preset.v1";
  label: string;
  pipeline: Pipeline;
  inputs: {
    [k: string]: TypedValue | undefined;
  };
  policy: InferencePresetPolicy;
  pins: {
    [k: string]:
      | {
          provider: string;
          load_revision: number;
          load_sha256: string;
          effective_load_sha256: string;
          recorded_model: {
            [k: string]: unknown | undefined;
          };
        }
      | undefined;
  };
  submissions?: {
    run_id: string;
    state: "reserved" | "accepted" | "rejected";
    request_id: string;
  }[];
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "InferencePresetPreflight".
 */
export interface InferencePresetPreflight {
  request: RunRequest;
  definition_sha256: string;
  revision: number;
  policy: InferencePresetPolicy;
  files_checked: number;
  source_recipe_sha256: string;
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "InferencePresetReceipt".
 */
export interface InferencePresetReceipt {
  run_id: string;
  state: string;
  origin: Origin;
  actual_recipe: string;
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "NativeProviderManifest".
 */
export interface NativeProviderManifest {
  schema_version: "1.0";
  provider_id: string;
  entry_point: string;
  label: string;
  kind: string;
  /**
   * @maxItems 128
   */
  inputs: {
    name: string;
    type_id: string;
    required: boolean;
    transport: "file" | "inline" | "either";
    description: string;
  }[];
  /**
   * @maxItems 128
   */
  outputs: {
    name: string;
    type_id: string;
    required: boolean;
    transport: "file" | "inline" | "either";
    description: string;
  }[];
  /**
   * @maxItems 64
   */
  operations: string[];
  settings_schema: {};
  parameters_schema: {};
  default_settings: {} | null;
  resources: {
    /**
     * @maxItems 8
     */
    devices: ("cpu" | "cuda" | "mps")[];
    /**
     * @maxItems 32
     */
    required_modules: string[];
    /**
     * @maxItems 16
     */
    executables: string[];
    vram_bytes: number | null;
    memory_basis: string;
  };
  /**
   * @maxItems 16
   */
  models: {
    id: string;
    revision: string;
    license: string;
    /**
     * @maxItems 64
     */
    variants: string[];
    /**
     * @maxItems 1024
     */
    files: {
      path: string;
      size_bytes: number;
      sha256: string | null;
    }[];
    file_scope: string;
  }[];
  execution: {
    cache: "none" | "per_request" | "content_addressed" | "conditional";
    retry: "never_automatic" | "verify_stopped_first" | "idempotent";
    cancellation: "cooperative" | "process_termination" | "unsupported";
    /**
     * @maxItems 8
     */
    progress: ("stage" | "updates" | "frames" | "bytes")[];
    error_contract: "ComponentError";
    retry_condition: string;
  };
  license: string;
  capability_version: string;
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "NativeProviderCatalog".
 */
export interface NativeProviderCatalog {
  schema_version: "1.0";
  node_id: string;
  items: NativeProviderInfo[];
  issues: {
    runtime_id: string;
    code: string;
  }[];
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "NativeProviderInfo".
 */
export interface NativeProviderInfo {
  runtime_id: string;
  provider_id: string;
  kind: string;
  label: string;
  available: boolean;
  reason: string | null;
  synthetic: boolean;
  default_settings: InstanceSettings | null;
  status: "declared" | "legacy" | "invalid";
  sha256: string | null;
  issue: string | null;
  manifest: NativeProviderManifest | null;
  distribution: {
    name?: string | null;
    version?: string | null;
  };
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioWriteReceipt".
 */
export interface StudioWriteReceipt {
  project_id: string;
  operation: string;
  request_sha256: string;
  state: "committed" | "reserved" | "retired" | "rejected";
  http_status: number | null;
  project_revision: number | null;
  current_project_revision: number | null;
  result_sha256: string | null;
  result:
    | StudioProject
    | StudioTimelineCommandsResult
    | StudioTakeAttachResult
    | StudioCreativeEntryVersion
    | StudioCreativeBindingVersion
    | ApiErrorBody
    | null;
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioGapPlanRequest".
 */
export interface StudioGapPlanRequest {
  revision: number;
  pipeline_id: string;
  track_id: string;
  start_frame: number;
  end_frame: number;
  prompt: string;
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioMediaTakeAdoptRequest".
 */
export interface StudioMediaTakeAdoptRequest {
  run_id: string;
  output_key: string;
  expected_revision: number;
  parent_take_id?: string | null;
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioRetakePlanRequest".
 */
export interface StudioRetakePlanRequest {
  revision: number;
  pipeline_id: string;
  track_id: string;
  start_frame: number;
  end_frame: number;
  prompt: string;
  mask_item_id?: string;
  probe_run_id?: string;
  probe_output_key?: string;
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioRenderSubmissionRequest".
 */
export interface StudioRenderSubmissionRequest {
  expected_revision: number;
  medium: "image" | "video";
  run: RunRequest;
  /**
   * @minItems 1
   * @maxItems 256
   */
  takes: {
    shot_id: string;
    take: {
      [k: string]: unknown | undefined;
    };
  }[];
  /**
   * @minItems 0
   * @maxItems 256
   */
  route_moves?: {
    shot_id: string;
    from_route: string;
    to_route: string;
  }[];
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioDraftBranchPlanRequest".
 */
export interface StudioDraftBranchPlanRequest {
  digest: string;
  candidate_id: string;
  pipeline_id: string;
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioSeamPlanRequest".
 */
export interface StudioSeamPlanRequest {
  revision: number;
  command: TimelineCommandRangeCandidate;
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioOtioEditsRequest".
 */
export interface StudioOtioEditsRequest {
  revision: number;
  document: {
    [k: string]: unknown | undefined;
  };
  relinks: {
    [k: string]: string | undefined;
  };
  /**
   * @minItems 1
   * @maxItems 16
   */
  track_ids?: string[];
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioOtioReferencePlanRequest".
 */
export interface StudioOtioReferencePlanRequest {
  revision: number;
  reference_run?: string;
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioPortableReport".
 */
export interface StudioPortableReport {
  source_project_id: string;
  source_revision: number;
  title: string;
  take_count: number;
  file_count: number;
  run_count: number;
  creative_version_count: number;
  requirements: {
    node_id: string;
    component_id: string;
    provider_id?: string;
    runtime_id?: string;
    component_available?: boolean;
    model_identity?: {};
    runtime_identity?: {};
  }[];
  missing: {
    kind: string;
    id: string;
  }[];
  importable: boolean;
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioPortableImport".
 */
export interface StudioPortableImport {
  project: StudioProject;
  report: StudioPortableReport;
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StudioPortableHistory".
 */
export interface StudioPortableHistory {
  runs: Run[];
  drafts: StudioDraftPlan[];
  requirements: {
    node_id: string;
    component_id: string;
    provider_id?: string;
    runtime_id?: string;
    component_available?: boolean;
    model_identity?: {};
    runtime_identity?: {};
  }[];
}
/**
 * x-phasyn-extension：一個已發布檔的身分（FileRef 的 node_id 與 file_id）。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StorageFileKey".
 */
export interface StorageFileKey {
  node_id: string;
  file_id: string;
}
/**
 * x-phasyn-extension：數量與位元組數；size_bytes＝已知大小的總和（大小未知的項目只計入 count）。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StorageTotal".
 */
export interface StorageTotal {
  count: number;
  size_bytes: number;
}
/**
 * x-phasyn-extension：每個類別的數量與大小。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StorageTotals".
 */
export interface StorageTotals {
  runs: StorageTotal;
  files: StorageTotal;
  remote_cache: StorageTotal;
  latents: StorageTotal;
  recordings: StorageTotal;
}
/**
 * x-phasyn-extension：回收規則。min_age_hours＝檔案與 run 至少要這麼舊才列入（保護剛上傳、尚未存進專案的檔案；沒有 scope 時至少 1）；recordings_older_than_days＝recordings 類別只列出早於這個天數的紀錄；include_standalone_runs＝runs 類別也列出不屬於任何專案的 run（phasynctl 或實驗直接建立的 run；預設不列）。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StorageCleanOptions".
 */
export interface StorageCleanOptions {
  min_age_hours?: number;
  recordings_older_than_days?: number;
  include_standalone_runs?: boolean;
}
/**
 * x-phasyn-extension：只在這些對象中找可回收的項目（刪除專案時一併清除它專屬的媒體）。project_ids＝origin 指名這些專案的 run；run_ids、files＝明確列出的 run 與檔案。仍被任何引用的項目一律不列入。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StorageScope".
 */
export interface StorageScope {
  /**
   * @maxItems 200
   */
  project_ids?: string[];
  /**
   * @maxItems 5000
   */
  run_ids?: string[];
  /**
   * @maxItems 20000
   */
  files?: StorageFileKey[];
}
/**
 * x-phasyn-extension：dry_run=true 只回計畫；dry_run=false 只處理 items 列出、而且在這次重新計算時仍符合條件的項目（其他一律不動）。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StorageCleanRequest".
 */
export interface StorageCleanRequest {
  /**
   * @minItems 1
   * @maxItems 5
   */
  categories: StorageCategory[];
  dry_run: boolean;
  options?: StorageCleanOptions;
  scope?: StorageScope;
  /**
   * @maxItems 20000
   */
  items?: string[];
}
/**
 * x-phasyn-extension：計畫或結果中的一個項目。item_id：run:<run_id>、file:<node_id>/<file_id>、remote:<持有的 node_id>/<來源 node_id>/<file_id>、latent:<project_id>/<shot_id>/<take_id>、recording:<持有者 id>/<recording_id>。status：planned＝試算；deleted＝已刪除；missing＝本來就不存在（視為完成）；kept＝保留（例如被固定或仍被引用）；skipped＝這次重新計算時已不符合條件，沒有動；failed＝刪除失敗（code、message 說明原因）。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StorageItem".
 */
export interface StorageItem {
  item_id: string;
  category: StorageCategory;
  status: "planned" | "deleted" | "missing" | "kept" | "skipped" | "failed";
  label: string;
  node_id: string | null;
  size_bytes: number | null;
  created_at: string | null;
  run_id?: string;
  project_id?: string;
  reason?: string;
  code?: string;
  message?: string;
}
/**
 * x-phasyn-extension：一個 Node 的檔案清單是否讀得到。ok；unsupported＝Node 版本沒有儲存清單 API（只回收主控端與 run 的項目）；unreachable＝離線或連不上；failed＝回覆無法使用。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StorageNodeState".
 */
export interface StorageNodeState {
  node_id: string;
  label: string;
  state: "ok" | "unsupported" | "unreachable" | "failed";
  message?: string;
}
/**
 * x-phasyn-extension：清理計畫（dry_run）或結果。items 每個類別最多列 2000 項（truncated=true 時 totals 仍是全部的總和）。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StorageCleanResult".
 */
export interface StorageCleanResult {
  dry_run: boolean;
  categories: StorageCategory[];
  options: {
    min_age_hours: number;
    recordings_older_than_days: number;
    include_standalone_runs: boolean;
  };
  scope: StorageScope | null;
  items: StorageItem[];
  totals: StorageTotals;
  truncated: boolean;
  nodes: StorageNodeState[];
  started_at: string;
  finished_at: string;
}
/**
 * x-phasyn-extension：儲存空間用量。controller 與 nodes 是磁碟上實際的檔案、run、紀錄大小；reclaimable 是用預設規則（不含獨立 run）各類別可回收的量；projects 是每個專案引用的媒體（exclusive_bytes＝只有這個專案引用的部分，刪除專案時可一併清除）。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StorageUsage".
 */
export interface StorageUsage {
  generated_at: string;
  controller: {
    files: StorageTotal;
    runs: StorageTotal;
    recordings: StorageTotal;
  };
  nodes: {
    node_id: string;
    label: string;
    state: "ok" | "unsupported" | "unreachable" | "failed";
    message?: string;
    files: StorageTotal | null;
    remote_cache: StorageTotal | null;
    recordings: StorageTotal | null;
    work?: StorageWork | null;
  }[];
  reclaimable: StorageTotals;
  standalone_runs: StorageTotal;
  projects: {
    project_id: string;
    title: string;
    runs: number;
    files: number;
    size_bytes: number;
    exclusive_bytes: number;
  }[];
  pins: number;
}
/**
 * x-phasyn-extension：元件程序的工作目錄（data_dir/work）。count／size_bytes＝目前所有程序目錄；enabled、ttl_hours＝自動清理設定；last_sweep＝這次 Node 啟動後最後一次清理（還沒跑過是 null）。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StorageWork".
 */
export interface StorageWork {
  count: number;
  size_bytes: number;
  enabled: boolean;
  ttl_hours: number;
  last_sweep: {
    at: string;
    removed: number;
    freed_bytes: number;
    failed: number;
  } | null;
}
/**
 * x-phasyn-extension：固定的 run 或檔案：儲存清理永遠不回收它們（固定的 run 連同它產生的檔案與紀錄）。實驗把要保留的證據固定在這裡。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StoragePin".
 */
export interface StoragePin {
  kind: "run" | "file";
  run_id?: string;
  node_id?: string;
  file_id?: string;
  note?: string;
  pinned_at?: string;
}
/**
 * x-phasyn-extension：所有固定的 run 與檔案（固定時間由舊到新）。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StoragePins".
 */
export interface StoragePins {
  /**
   * @maxItems 20000
   */
  items: StoragePin[];
}
/**
 * x-phasyn-extension：新增與移除固定（pinned_at 由主控填寫；已固定的再固定只更新 note；移除不存在的固定不算錯誤）。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "StoragePinsRequest".
 */
export interface StoragePinsRequest {
  /**
   * @maxItems 5000
   */
  add?: StoragePin[];
  /**
   * @maxItems 5000
   */
  remove?: StoragePin[];
}
/**
 * x-phasyn-extension：Node 的檔案、遠端副本與本機紀錄清單（主控的儲存清理讀取）。files＝本機已發布檔（links＝metadata.links 指到的檔案）；remote＝files/remote 下已驗證的副本；recordings＝本機紀錄（open＝仍在寫入或屬於執行中的呼叫）。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "NodeStorageInventory".
 */
export interface NodeStorageInventory {
  node_id: string;
  files: {
    file_id: string;
    size_bytes: number;
    sha256: string;
    created_at: string | null;
    links: StorageFileKey[];
  }[];
  remote: {
    node_id: string;
    file_id: string;
    size_bytes: number;
    sha256: string;
    created_at: string | null;
  }[];
  recordings: {
    recording_id: string;
    created_at: string | null;
    run_id: string | null;
    size_bytes: number;
    open: boolean;
  }[];
  busy_files: StorageFileKey[];
  work?: StorageWork;
}
/**
 * x-phasyn-extension：主控要 Node 刪除的本機檔、遠端副本與本機紀錄（每項只送一次，不自動重送）。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "NodeStorageCleanRequest".
 */
export interface NodeStorageCleanRequest {
  /**
   * @maxItems 5000
   */
  files?: string[];
  /**
   * @maxItems 5000
   */
  remote?: StorageFileKey[];
  /**
   * @maxItems 5000
   */
  recordings?: string[];
}
/**
 * x-phasyn-extension：每一項的結果。kept＝正被執行中的呼叫使用或紀錄仍在寫入，沒有刪除。
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "NodeStorageCleanResult".
 */
export interface NodeStorageCleanResult {
  items: {
    kind: "file" | "remote" | "recording";
    node_id: string;
    id: string;
    status: "deleted" | "missing" | "kept" | "failed";
    size_bytes: number | null;
    code?: string;
    message?: string;
  }[];
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "LoraTrainingSource".
 */
export interface LoraTrainingSource {
  file: FileRef;
  label?: string;
  role?: "train" | "heldout" | "eval_only";
}
/**
 * x-phasyn-extension：比較路線：一個已存的元件組合（含一個 H3 DiT 步驟）；各強度只換掉那個 DiT
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "LoraTrainingRoute".
 */
export interface LoraTrainingRoute {
  route_id: string;
  label?: string;
  pipeline_id: string;
  dit_parameters?: {
    steps?: number;
    video_shift?: number;
    audio_shift?: number;
  };
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "LoraTrainingEvalPrompt".
 */
export interface LoraTrainingEvalPrompt {
  prompt: string;
  /**
   * @minItems 1
   * @maxItems 4
   */
  references: FileRef[];
}
/**
 * x-phasyn-extension：LoRA 訓練的選項；全部可省略（使用預設）
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "LoraTrainingOptions".
 */
export interface LoraTrainingOptions {
  review_before_training?: boolean;
  /**
   * @minItems 1
   * @maxItems 7
   */
  strengths?: number[];
  early_compare_step?: number | null;
  eval_count?: number;
  /**
   * @maxItems 6
   */
  eval_prompts?: LoraTrainingEvalPrompt[];
  /**
   * @maxItems 3
   */
  eval_routes?: LoraTrainingRoute[];
  eval_width?: number;
  eval_height?: number;
  eval_frames?: number;
  seed?: number;
  steps?: number | null;
  rank?: number;
  alpha?: number;
  learning_rate?: number;
  sigma_min?: number;
  chunk_steps?: number;
  max_clips?: number;
  max_source_share?: number;
  caption_prefix?: string;
  allow_replace_idle_dit?: boolean;
  train_node_id?: string | null;
  max_auto_resumes?: number;
}
/**
 * x-phasyn-extension：建立 LoRA 訓練工作：影片、訓練方向與選用設定
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "LoraTrainingRequest".
 */
export interface LoraTrainingRequest {
  name?: string;
  direction: string;
  /**
   * @minItems 1
   * @maxItems 64
   */
  sources: LoraTrainingSource[];
  options?: LoraTrainingOptions;
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "LoraTrainingAction".
 */
export interface LoraTrainingAction {
  action: "start_training" | "cancel" | "resume" | "stop_training" | "decide";
  choice?: "keep" | "discard";
  strength?: number;
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "LoraTrainingClipEdit".
 */
export interface LoraTrainingClipEdit {
  /**
   * @maxItems 4000
   */
  drop?: string[];
  /**
   * @maxItems 4000
   */
  restore?: string[];
  captions?: {
    [k: string]: string | undefined;
  };
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "LoraTrainingSummary".
 */
export interface LoraTrainingSummary {
  training_id: string;
  name: string;
  direction: string;
  status: "running" | "stopping" | "review" | "paused" | "completed" | "failed" | "cancelled";
  phase:
    "clips" | "review" | "select" | "encode" | "train" | "compare" | "decide" | "register" | "registered" | "discarded";
  created_at: string;
  updated_at: string;
  progress?: {
    [k: string]: unknown | undefined;
  } | null;
  error?: {
    [k: string]: unknown | undefined;
  } | null;
  decision?: {
    [k: string]: unknown | undefined;
  } | null;
  registered?: {
    [k: string]: unknown | undefined;
  } | null;
}
/**
 * x-phasyn-extension：一個 LoRA 訓練工作的完整文件（每個階段的 run、資料、訓練與比較結果）
 *
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "LoraTraining".
 */
export interface LoraTraining {
  training_id: string;
  job_key?: string;
  name: string;
  direction: string;
  status: "running" | "stopping" | "review" | "paused" | "completed" | "failed" | "cancelled";
  phase:
    "clips" | "review" | "select" | "encode" | "train" | "compare" | "decide" | "register" | "registered" | "discarded";
  created_at: string;
  updated_at: string;
  progress?: {
    [k: string]: unknown | undefined;
  } | null;
  options: {
    [k: string]: unknown | undefined;
  };
  sources: {
    [k: string]: unknown | undefined;
  }[];
  placement?: {
    [k: string]: unknown | undefined;
  };
  runs: {
    [k: string]: unknown | undefined;
  }[];
  artifacts: {
    [k: string]: unknown | undefined;
  };
  selection?: {
    [k: string]: unknown | undefined;
  } | null;
  dataset_summary?: {
    [k: string]: unknown | undefined;
  };
  clips?: {
    [k: string]: unknown | undefined;
  }[];
  eval_items?: {
    [k: string]: unknown | undefined;
  }[];
  training?: {
    [k: string]: unknown | undefined;
  } | null;
  comparison: {
    [k: string]: unknown | undefined;
  };
  decision?: {
    [k: string]: unknown | undefined;
  } | null;
  registered?: {
    [k: string]: unknown | undefined;
  } | null;
  error?: {
    [k: string]: unknown | undefined;
  } | null;
  events: {
    [k: string]: unknown | undefined;
  }[];
  [k: string]: unknown | undefined;
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "LoraTrainingList".
 */
export interface LoraTrainingList {
  items: LoraTrainingSummary[];
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "LocalImportRequest".
 */
export interface LocalImportRequest {
  root: number;
  path: string;
}
/**
 * This interface was referenced by `PhasynStudioContracts`'s JSON-Schema
 * via the `definition` "LocalImportListing".
 */
export interface LocalImportListing {
  roots?: {
    root: number;
    name: string;
  }[];
  root?: number;
  path?: string;
  truncated?: boolean;
  entries?: {
    name: string;
    kind: "folder" | "video";
    size_bytes?: number;
    modified?: number;
  }[];
}
