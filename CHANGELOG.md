# Changelog

**English** | [繁體中文](#繁體中文) | [日本語](#日本語)

## 1.1.0

### New

- **Fix menu**: improve a finished take without starting over — restore detail, smooth motion, replace the sound,
  retake a part of the shot or extend it.
- **Dialogue**: recognise the lines in a clip as captions, and dub a line with a generated voice.
- **Work list**: one list of everything that is rendering or waiting, with what each job is waiting for.
- **Storage**: a storage page that shows what uses disk space and cleans up media no project needs; pin what to keep.
  Removing a project can also remove its media.
- **Export**: the export dialog has four tabs, and a project can be saved as a portable package and opened on another
  machine.
- **Projects**: select several projects and remove them at once.
- **Render button**: one engine button that turns amber and says why when the selected route is not ready.
- More editing: export with a loudness target, automatic ducking of music under dialogue, faster clip speeds.
- **Several LoRAs on one video model**: stack style LoRAs (with at most one speed-up LoRA) on the same shot.
- **Extend** now returns one longer take instead of a separate piece to join.
- A replacement soundtrack is converted to the format the video needs automatically.
- **Work-directory cleanup**: a Node removes the leftover working files of components that have stopped.
- New optional components: Wan video editing and speech-driven animation, SeedVR2 restoration, RIFE frame
  interpolation, pose and depth controls, and an exchange with Krita for hand-painted revisions.
- **LoRA training from your own videos (experimental)**: drop in videos and describe the style you want; Phasyn cuts
  them into clips, captions them automatically, holds some out for evaluation, trains an H3 LoRA in resumable chunks
  and renders the same prompts at several LoRA strengths so you can compare before keeping it. Subtitles and
  translucent logos or watermarks are found and masked out of training (clips where they cannot be placed are
  dropped and listed). Needs the H3 weights and a large or unified-memory GPU node.
- **Reference image size**: Ref2VA reference images can be prepared at a 736, 768 or 1024 short edge, which makes
  generation faster.

### Changed

- The FLUX.2 klein and ComfyUI image providers are removed; Image Studio uses Qwen-Image.
- A calmer shot properties panel and a one-row prompt toolbar.

### Fixed

- Security hardening of file paths and the preview fetcher (path traversal and server-side request forgery), reported
  by @hevangel in #1. Thank you!
- Captions no longer overlap; transcripts follow the requested Chinese script.
- Restore and frame interpolation keep the take's own resolution instead of a fixed size.
- Muxing refuses an invalid frame rate with a clear error instead of failing later.
- A run no longer stays "running" forever when a node's reply is lost: the controller reads the result back from
  the node, and a call the node does not know ends instead of hanging.
- LoRA training resumes automatically from its last checkpoint when a training or comparison step stalls.
- Many smaller fixes to the phone layout, take comparison, project removal and English texts.

## 繁體中文

### 新功能

- **修正選單**：不用重拍就能改善完成的 take：修復細節、讓動作更順、換掉聲音、局部重製或延長鏡頭。
- **對白辨識與配音**：把片段裡的台詞辨識成字幕，並用生成的聲音為台詞配音。
- **工作清單**：一個清單列出所有正在渲染或等待中的工作，以及每個工作在等什麼。
- **儲存空間清理**：新的儲存空間頁面，顯示什麼佔用了磁碟，清掉沒有專案需要的素材；可以釘選要保留的檔案。移除專案時也可以一起移除它的素材。
- **匯出**：匯出視窗分成四個分頁；專案可以存成可攜包，在另一台電腦開啟。
- **專案多選移除**：在專案列表一次選取並移除多個專案。
- **渲染引擎按鈕**：只有一個引擎按鈕，選的路由還沒準備好時會變成琥珀色並說明原因。
- 更多剪輯功能：依目標響度匯出、對白出現時自動壓低音樂、更快的片段速度。
- **串接多個 LoRA**：同一個影片模型可以疊加多個風格 LoRA（加速 LoRA 最多一個）。
- **延長鏡頭**現在直接產生一個更長的 take，不用再另外接起來。
- 換上的配樂或配音會自動轉成影片需要的格式。
- **工作暫存清理**：Node 會清掉已停止元件留下的工作檔案。
- 新的選用元件：Wan 影片編修與語音驅動動畫、SeedVR2 畫質修復、RIFE 補幀、姿勢與深度控制，以及和 Krita 互傳手繪修改稿。
- **用自己的影片訓練 LoRA（實驗性）**：放入影片並描述想要的風格，Phasyn 會切成片段、自動反推描述、保留一部分做評估，分段訓練 H3 LoRA（可接續），並用同樣的 Prompt 產生不同 LoRA 強度的結果，比較後再決定是否保留。字幕和半透明的標誌、浮水印會被偵測並排除在訓練之外（無法定位的片段會被剔除並列出）。需要 H3 權重，以及大顯存或統一記憶體的 GPU Node。
- **參考圖尺寸**：Ref2VA 參考圖可以用 736、768 或 1024 的短邊準備，生成更快。

### 變更

- 移除 FLUX.2 klein 與 ComfyUI 圖片 provider；Image Studio 使用 Qwen-Image。
- 鏡頭屬性面板更簡潔，Prompt 工具列只佔一列。

### 修正

- 加強檔案路徑與預覽擷取的安全性（路徑穿越與伺服器端請求偽造），感謝 @hevangel 在 #1 回報。
- 字幕不再重疊；逐字稿使用指定的中文字體（繁體或簡體）。
- 手機版面、take 比較、專案移除與英文文字的多項小修正。
- 畫質修復與補幀改用片段本身的解析度，不再固定尺寸。
- 合成影片遇到無效的影格率時會清楚報錯，不會到後面才失敗。
- Node 的回覆遺失時，執行不會再永遠停在「執行中」：主控會向 Node 取回結果，Node 不認得的呼叫會直接結束而不是卡住。
- LoRA 訓練的訓練或比較步驟停滯時，會自動從最近的存檔接著訓練。

## 日本語

### 新機能

- **修正メニュー**：完成した take を撮り直さずに改善：ディテールの修復、動きの補間、音の差し替え、部分的な撮り直しや延長。
- **セリフ認識と吹き替え**：クリップのセリフを字幕として認識し、生成した声で吹き替え。
- **作業リスト**：レンダリング中・待機中の作業と、それぞれが何を待っているかを一覧表示。
- **ストレージ**：ディスクを使っているものを表示し、どのプロジェクトにも不要な素材を整理するページ。残すものはピン留めできます。
- **書き出し**：書き出しダイアログが 4 つのタブに。プロジェクトをポータブルパッケージとして保存し、別のマシンで開けます。
- **プロジェクトの複数選択削除**と、ルートの準備ができていないときに理由を示す**レンダーボタン**。
- **複数 LoRA の重ね掛け**（高速化 LoRA は 1 つまで）、**延長**は 1 本の長い take を返すように、差し替えた音声は自動で変換、停止したコンポーネントの作業ファイルを Node が自動で削除。
- **自分の動画から LoRA を学習（実験的）**：動画を入れて目指すスタイルを書くと、クリップへの切り分け、自動キャプション、評価用クリップの確保、再開可能なチャンクでの H3 LoRA 学習を行い、同じプロンプトを複数の LoRA 強度でレンダリングして比較できます。字幕や半透明のロゴ・透かしは検出して学習から除外します。H3 の重みと、大容量または統合メモリの GPU Node が必要です。
- **参照画像のサイズ**：Ref2VA の参照画像を短辺 736・768・1024 で準備でき、生成が速くなります。
- FLUX.2 klein と ComfyUI の画像プロバイダーを削除しました（Image Studio は Qwen-Image を使います）。
- ファイルパスとプレビュー取得のセキュリティを強化しました。報告してくれた @hevangel（#1）に感謝します。
- 画質修復とフレーム補間はテイク本来の解像度を保ち、無効なフレームレートでの多重化はすぐに分かりやすいエラーになります。
- Node の応答が失われても、実行が「実行中」のまま止まらなくなりました（結果を Node から取り直し、Node が知らない呼び出しは終了します）。LoRA 学習のステップが停滞したときは、最後のチェックポイントから自動で再開します。
