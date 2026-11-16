// 局部遮罩：在底圖（拉伸到輸出比例）上畫可編輯區域。藍色＝使用新生成內容，
// 其餘保留底圖；模型先參考圖片生成完整畫面，再由 image.compose 依遮罩合成——不是原生 inpaint。
// 工具：筆刷、橡皮擦、筆刷大小、復原、清空、全選、反轉、匯入灰階遮罩、停用遮罩、保存遮罩。
// 鍵盤（畫布有焦點時）：方向鍵移動游標（Shift 加大）、空白鍵蓋一筆、Enter 落筆／提筆（落筆時移動就是畫線）、
// [ ] 調整筆刷、B 筆刷、E 橡皮擦、Ctrl+Z 復原、Esc 提筆。繪製結果先存在這個分頁（maskDrafts），保存或生成時才上傳。
import { Brush, Eraser, FileUp, LoaderCircle, Maximize, Save, SquareDashed, Trash2, Undo2 } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { useImageStudio } from "../imageStudioContext";
import { BRUSH, canvasPoint, clampBrush, editableFraction, fillAlpha, historyLimit, importSizeProblem, keyboardStep, luminanceToAlpha, maskExtentNote, moveCursor, type CanvasPoint } from "../model/mask";
import { baseItemId } from "../model/references";
import { errorText } from "../support";
import type { StudioImageShot } from "../types";
import { maskDrafts, uploadMaskDraft, useMaskDraftDirty, warnUnsavedMasks } from "../hooks/maskDrafts";
import { fileUrl } from "./display";
import { t } from "@/i18n";

const OVERLAY = "rgba(138,184,245,0.52)";

function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error(t("瀏覽器無法建立遮罩畫布，請重新載入或改用匯入遮罩"));
  return context;
}

function blankCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function drawStroke(mask: HTMLCanvasElement, from: CanvasPoint, to: CanvasPoint, size: number, erase: boolean) {
  const context = context2d(mask);
  context.save();
  context.globalCompositeOperation = erase ? "destination-out" : "source-over";
  context.fillStyle = "#fff";
  context.strokeStyle = "#fff";
  context.lineWidth = size;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.beginPath();
  context.arc(to.x, to.y, size / 2, 0, Math.PI * 2);
  context.fill();
  context.beginPath();
  context.moveTo(from.x, from.y);
  context.lineTo(to.x, to.y);
  context.stroke();
  context.restore();
}

function paintOverlay(view: HTMLCanvasElement, mask: HTMLCanvasElement, inverted: boolean) {
  const context = context2d(view);
  context.clearRect(0, 0, view.width, view.height);
  context.save();
  if (inverted) {
    context.fillStyle = OVERLAY;
    context.fillRect(0, 0, view.width, view.height);
    context.globalCompositeOperation = "destination-out";
    context.drawImage(mask, 0, 0, view.width, view.height);
  } else {
    context.drawImage(mask, 0, 0, view.width, view.height);
    context.globalCompositeOperation = "source-in";
    context.fillStyle = OVERLAY;
    context.fillRect(0, 0, view.width, view.height);
  }
  context.restore();
}

function decode(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(t("圖片無法解碼或讀取")));
    image.src = src;
  });
}

export function MaskPainter({ shot, disabled }: { shot: StudioImageShot; disabled: boolean }) {
  const { project, dispatch, notify } = useImageStudio();
  const id = useId();
  const { width, height, image_shot_id: shotId } = shot;
  const library = project.library ?? [];
  const baseId = baseItemId(shot);
  const base = baseId ? library.find((item) => item.item_id === baseId) : undefined;
  const saved = shot.mask_item_id ? library.find((item) => item.item_id === shot.mask_item_id) : undefined;
  const baseUrl = fileUrl(base?.file);
  const savedUrl = fileUrl(saved?.file);
  const dirty = useMaskDraftDirty(shotId);
  const hasMask = dirty || shot.mask_item_id !== null;
  const invert = shot.mask_invert && hasMask;

  const maskRef = useRef<HTMLCanvasElement | null>(null);
  const view = useRef<HTMLCanvasElement>(null);
  const history = useRef<ImageData[]>([]);
  const stroke = useRef<{ pointerId: number; point: CanvasPoint } | null>(null);
  const loadedKey = useRef<string | null>(null);
  const [historyCount, setHistoryCount] = useState(0);
  const [tool, setTool] = useState<"brush" | "erase">("brush");
  const [brush, setBrush] = useState<number>(BRUSH.initial);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // What the last action did (imported, saved, disabled); it lasts until the mask next changes. How much of the image
  // the mask covers is not a notice: maskExtentNote derives it from the current pixels on every render.
  const [notice, setNotice] = useState<string | null>(null);
  const [cursor, setCursor] = useState<(CanvasPoint & { source: "pointer" | "keyboard" }) | null>(null);
  const [penDown, setPenDown] = useState(false);
  const [coverage, setCoverage] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [retry, setRetry] = useState(0);

  useEffect(() => warnUnsavedMasks(), []);

  const mask = () => {
    maskRef.current ??= blankCanvas(width, height);
    return maskRef.current;
  };

  const repaint = (inverted = invert) => {
    if (view.current && maskRef.current) paintOverlay(view.current, maskRef.current, inverted);
  };

  /** 把畫布內容存成這張圖片的草稿（還沒保存的遮罩）。 */
  const commit = () => {
    const canvas = mask();
    const data = context2d(canvas).getImageData(0, 0, canvas.width, canvas.height).data;
    maskDrafts.set(shotId, { width: canvas.width, height: canvas.height, data: new Uint8ClampedArray(data) });
    setCoverage(editableFraction(data, shot.mask_invert));
    setNotice(null);
  };

  const remember = () => {
    const canvas = mask();
    history.current.push(context2d(canvas).getImageData(0, 0, canvas.width, canvas.height));
    const limit = historyLimit(canvas.width, canvas.height);
    while (history.current.length > limit) history.current.shift();
    setHistoryCount(history.current.length);
  };

  // 載入：這個分頁有草稿就用草稿，否則讀保存的遮罩檔；尺寸改變時把現有內容縮放到新尺寸
  useLayoutEffect(() => {
    const canvas = mask();
    if (canvas.width !== width || canvas.height !== height) {
      const previous = blankCanvas(canvas.width, canvas.height);
      context2d(previous).drawImage(canvas, 0, 0);
      canvas.width = width;
      canvas.height = height;
      context2d(canvas).drawImage(previous, 0, 0, width, height);
      history.current = [];
      setHistoryCount(0);
      if (maskDrafts.has(shotId)) commit();
    }
    const key = `${shotId}:${shot.mask_item_id ?? ""}:${retry}`;
    if (loadedKey.current === key) {
      repaint();
      return;
    }
    loadedKey.current = key;
    const draft = maskDrafts.get(shotId);
    const context = context2d(canvas);
    if (draft) {
      const holder = blankCanvas(draft.width, draft.height);
      context2d(holder).putImageData(new ImageData(new Uint8ClampedArray(draft.data), draft.width, draft.height), 0, 0);
      context.clearRect(0, 0, width, height);
      context.drawImage(holder, 0, 0, width, height);
      setCoverage(editableFraction(context.getImageData(0, 0, width, height).data, shot.mask_invert));
      repaint();
      return;
    }
    context.clearRect(0, 0, width, height);
    repaint();
    setCoverage(null);
    if (!savedUrl) return;
    let active = true;
    setLoading(true);
    setError(null);
    decode(savedUrl)
      .then((image) => {
        if (!active) return;
        context.clearRect(0, 0, width, height);
        context.drawImage(image, 0, 0, width, height);
        const pixels = context.getImageData(0, 0, width, height);
        luminanceToAlpha(pixels.data);
        context.putImageData(pixels, 0, 0);
        setCoverage(editableFraction(pixels.data, shot.mask_invert));
        repaint();
      })
      .catch((reason: unknown) => {
        if (active) setError(t("保存的遮罩讀不到：{reason}", { reason: errorText(reason) }));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
    // repaint／commit 讀最新的 props；只在圖片、尺寸、保存的遮罩改變時重新載入
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shotId, width, height, shot.mask_item_id, savedUrl, retry]);

  useEffect(() => {
    repaint(invert);
    if (maskRef.current) setCoverage(editableFraction(context2d(maskRef.current).getImageData(0, 0, width, height).data, shot.mask_invert));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invert]);

  const blocked = disabled || loading;
  const erase = tool === "erase";

  const startStroke = (event: PointerEvent<HTMLCanvasElement>) => {
    if (blocked || stroke.current || event.button !== 0) return;
    event.preventDefault();
    const point = canvasPoint(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect(), width, height);
    remember();
    stroke.current = { pointerId: event.pointerId, point };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // 指標已放開：照樣畫這一點
    }
    drawStroke(mask(), point, point, brush, erase);
    repaint();
  };

  const moveStroke = (event: PointerEvent<HTMLCanvasElement>) => {
    const point = canvasPoint(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect(), width, height);
    setCursor({ ...point, source: "pointer" });
    const current = stroke.current;
    if (!current || current.pointerId !== event.pointerId) return;
    drawStroke(mask(), current.point, point, brush, erase);
    current.point = point;
    repaint();
  };

  const endStroke = (event: PointerEvent<HTMLCanvasElement>) => {
    if (stroke.current?.pointerId !== event.pointerId) return;
    stroke.current = null;
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // 已釋放
    }
    commit();
  };

  const fill = (editableEverywhere: boolean) => {
    remember();
    const canvas = mask();
    const context = context2d(canvas);
    context.clearRect(0, 0, width, height);
    if (fillAlpha(editableEverywhere, shot.mask_invert) === 255) {
      context.fillStyle = "#fff";
      context.fillRect(0, 0, width, height);
    }
    repaint(shot.mask_invert);
    commit();
  };

  const undo = () => {
    const previous = history.current.pop();
    setHistoryCount(history.current.length);
    if (!previous) return;
    context2d(mask()).putImageData(previous, 0, 0);
    repaint();
    commit();
  };

  const disable = () => {
    maskDrafts.clear(shotId);
    history.current = [];
    setHistoryCount(0);
    context2d(mask()).clearRect(0, 0, width, height);
    repaint(false);
    setCoverage(null);
    setPenDown(false);
    if (shot.mask_item_id !== null) dispatch({ type: "setMask", shotId, item: null });
    setNotice(t("遮罩已停用：參考圖片仍會送出，生成完整畫面。"));
  };

  const importMask = async (file: File) => {
    const url = URL.createObjectURL(file);
    setError(null);
    setLoading(true);
    try {
      const image = await decode(url);
      const tooBig = importSizeProblem(image.naturalWidth, image.naturalHeight);
      if (tooBig) throw new Error(tooBig);
      remember();
      const context = context2d(mask());
      context.clearRect(0, 0, width, height);
      context.drawImage(image, 0, 0, width, height);
      const pixels = context.getImageData(0, 0, width, height);
      luminanceToAlpha(pixels.data);
      context.putImageData(pixels, 0, 0);
      repaint();
      commit();
      setNotice(t("已匯入灰階遮罩：白色使用新內容、黑色保留底圖、灰色柔化邊界。按「保存遮罩」或生成時上傳。"));
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      URL.revokeObjectURL(url);
      setLoading(false);
    }
  };

  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const action = await uploadMaskDraft(shot);
      if (action?.type === "setMask") {
        // 剛保存的內容就是畫布上的內容：不必重新讀檔
        loadedKey.current = `${shotId}:${action.item?.item_id ?? ""}:${retry}`;
        dispatch(action);
        setNotice(t("遮罩已保存到專案素材庫。"));
      }
    } catch (reason) {
      notify({ tone: "danger", title: t("遮罩保存失敗"), detail: t("{reason}（草稿保留，可以再按一次保存）", { reason: errorText(reason) }) });
    } finally {
      setSaving(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLCanvasElement>) => {
    if (blocked) return;
    const current = cursor?.source === "keyboard" ? cursor : { x: width / 2, y: height / 2, source: "keyboard" as const };
    const step = keyboardStep(width, height, event.shiftKey);
    const moved = moveCursor(current, event.key, step, width, height);
    if (moved) {
      event.preventDefault();
      if (penDown) {
        drawStroke(mask(), current, moved, brush, erase);
        repaint();
      }
      setCursor({ ...moved, source: "keyboard" });
      return;
    }
    if (event.key === " ") {
      event.preventDefault();
      remember();
      drawStroke(mask(), current, current, brush, erase);
      repaint();
      commit();
      setCursor(current);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (!penDown) remember();
      else commit();
      setPenDown(!penDown);
      setCursor(current);
    } else if (event.key === "Escape" && penDown) {
      event.preventDefault();
      event.stopPropagation();
      setPenDown(false);
      commit();
    } else if (event.key === "[" || event.key === "]") {
      event.preventDefault();
      setBrush((size) => clampBrush(size + (event.key === "]" ? BRUSH.step * 2 : -BRUSH.step * 2)));
    } else if (event.key === "b" || event.key === "B") {
      setTool("brush");
    } else if (event.key === "e" || event.key === "E") {
      setTool("erase");
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
      event.preventDefault();
      undo();
    }
  };

  if (!baseUrl) {
    return (
      <p className="rounded-lg border border-dashed border-line px-3 py-3 text-caption text-fg-tertiary">
        {t("遮罩畫在底圖上：先在上方的參考圖片中，按其中一張的「底圖」。")}
      </p>
    );
  }

  const outline = cursor ? { left: `${(cursor.x / width) * 100}%`, top: `${(cursor.y / height) * 100}%`, width: `${(brush / width) * 100}%` } : null;
  const extent = hasMask ? maskExtentNote(coverage) : null;
  const toolButton = "min-h-7 px-2 aria-pressed:border-brand-blue/50 aria-pressed:bg-brand-gradient-soft aria-pressed:text-fg aria-pressed:[&_svg]:text-brand-cyan";
  return (
    <div className="grid min-w-0 gap-2">
      <div className="flex flex-wrap items-center gap-1 rounded-lg border border-line-subtle bg-canvas p-1" role="toolbar" aria-label={t("遮罩工具")}>
        <Button size="sm" variant={tool === "brush" ? "secondary" : "quiet"} className={toolButton} icon={<Brush aria-hidden />} aria-pressed={tool === "brush"} disabled={blocked} onClick={() => setTool("brush")} title={t("筆刷（B）：畫出要重新生成的區域")}>
          {t("筆刷")}
        </Button>
        <Button size="sm" variant={tool === "erase" ? "secondary" : "quiet"} className={toolButton} icon={<Eraser aria-hidden />} aria-pressed={tool === "erase"} disabled={blocked} onClick={() => setTool("erase")} title={t("橡皮擦（E）")}>
          {t("橡皮擦")}
        </Button>
        <Button size="sm" variant="quiet" className={toolButton} icon={<Undo2 aria-hidden />} disabled={blocked || historyCount === 0} onClick={undo} title={t("復原（Ctrl+Z）")}>
          {t("復原")}
        </Button>
        <Button size="sm" variant="quiet" className={toolButton} icon={<SquareDashed aria-hidden />} disabled={blocked} onClick={() => fill(false)} title={t("清空：整張保留底圖")}>
          {t("清空")}
        </Button>
        <Button size="sm" variant="quiet" className={toolButton} icon={<Maximize aria-hidden />} disabled={blocked} onClick={() => fill(true)} title={t("全選：整張使用新生成內容")}>
          {t("全選")}
        </Button>
      </div>
      <label className="grid gap-1 text-caption text-fg-secondary">
        <span className="flex flex-wrap items-baseline gap-x-1.5">
          <span>{t("筆刷直徑")}</span>
          <span className="machine text-fg">{`${brush} px`}</span>
          <span className="text-fg-tertiary">{t("（[ ] 調整）")}</span>
        </span>
        <input type="range" min={BRUSH.min} max={BRUSH.max} step={BRUSH.step} value={brush} disabled={blocked} onChange={(event) => setBrush(clampBrush(Number(event.target.value)))} className="accent-action" />
      </label>
      <div className="relative w-full overflow-hidden rounded-lg border border-line-subtle bg-stage shadow-edge" style={{ aspectRatio: `${width} / ${height}` }}>
        <img src={baseUrl} alt={t("遮罩合成底圖（拉伸到輸出比例）")} draggable={false} className="absolute inset-0 size-full object-fill select-none" />
        <canvas
          ref={view}
          width={width}
          height={height}
          tabIndex={blocked ? -1 : 0}
          role="application"
          aria-roledescription={t("遮罩畫布")}
          aria-label={t("在底圖上繪製可編輯區域")}
          aria-describedby={`${id}-keys`}
          onPointerDown={startStroke}
          onPointerMove={moveStroke}
          onPointerUp={endStroke}
          onPointerCancel={endStroke}
          onPointerLeave={() => setCursor((value) => (value?.source === "pointer" ? null : value))}
          onLostPointerCapture={() => {
            if (stroke.current) {
              stroke.current = null;
              commit();
            }
          }}
          onKeyDown={onKeyDown}
          onBlur={() => {
            if (penDown) {
              setPenDown(false);
              commit();
            }
          }}
          className={cn("absolute inset-0 size-full touch-none outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset", blocked ? "cursor-not-allowed" : "cursor-crosshair")}
        />
        {outline ? (
          <span
            aria-hidden
            className={cn("pointer-events-none absolute aspect-square -translate-x-1/2 -translate-y-1/2 rounded-full border shadow-[0_0_0_1px_rgb(0_0_0/0.45)]", penDown ? "border-warning" : "border-fg", erase && "border-dashed")}
            style={outline}
          />
        ) : null}
        {loading ? (
          <span role="status" className="absolute inset-0 grid place-items-center bg-sunken/50 text-caption text-fg-secondary">
            <span className="material-hud inline-flex items-center gap-1.5 rounded-full border border-white/10 px-2.5 py-1">
              <LoaderCircle aria-hidden className="size-3.5 animate-spin" />
              {t("讀取遮罩…")}
            </span>
          </span>
        ) : null}
      </div>
      <p id={`${id}-keys`} className="text-caption text-fg-tertiary">
        {t("藍色＝使用新生成內容，其餘保留底圖（不是原生 inpaint：先生成完整畫面再依遮罩合成）。鍵盤：方向鍵移動游標（Shift 加大）、空白鍵蓋一筆、Enter 落筆／提筆、[ ] 筆刷大小、B／E 切換工具、Ctrl+Z 復原。")}
      </p>
      <p aria-live="polite" className="sr-only">
        {cursor?.source === "keyboard" ? t("游標 {x}, {y}；{value}；{value2} {brush} px", { x: Math.round(cursor.x), y: Math.round(cursor.y), value: penDown ? t("落筆") : t("提筆"), value2: erase ? t("橡皮擦") : t("筆刷"), brush }) : ""}
      </p>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <label className="pressable flex items-center gap-2 rounded-md px-1 text-caption text-fg-secondary has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-focus" title={hasMask ? t("反轉後，畫到的範圍改為保留區") : t("還沒有遮罩")}>
          <input type="checkbox" className="size-3.5 accent-action" checked={shot.mask_invert} disabled={blocked || !hasMask} onChange={(event) => dispatch({ type: "updateImageShot", shotId, patch: { mask_invert: event.target.checked } })} />
          {t("反轉遮罩")}
        </label>
        <span className="text-caption text-fg-tertiary">
          {hasMask ? (coverage === null ? t("可編輯範圍：讀取中") : t("可編輯範圍 {coverage}%", { coverage: Math.round(coverage * 100) })) : t("沒有遮罩：生成完整畫面")}
        </span>
        <label className="pressable ml-auto inline-flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-caption text-action-fg hover:bg-raised has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-focus has-disabled:cursor-not-allowed has-disabled:text-fg-disabled">
          <FileUp aria-hidden className="size-3.5" />
          {t("匯入灰階遮罩")}
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="sr-only"
            disabled={blocked}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void importMask(file);
            }}
          />
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Button size="sm" variant="secondary" icon={<Save aria-hidden />} pending={saving} disabled={blocked || !dirty} onClick={() => void save()} title={dirty ? t("上傳成專案素材庫的一張 PNG，寫進這張圖片") : t("沒有未保存的遮罩變更")}>
          {t("保存遮罩")}
        </Button>
        <Button size="sm" variant="quiet" icon={<Trash2 aria-hidden />} disabled={disabled || (!hasMask && !error)} onClick={disable}>
          {t("停用遮罩")}
        </Button>
        {dirty ? <span className="text-caption text-warning">{t("有未保存的遮罩變更（生成時會一併保存）")}</span> : null}
      </div>
      {notice || extent ? (
        <p role="status" className="grid gap-0.5 text-caption text-fg-tertiary">
          {notice ? <span>{notice}</span> : null}
          {extent ? <span>{extent}</span> : null}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="flex flex-wrap items-center gap-2 text-caption text-danger">
          {error}
          {shot.mask_item_id ? (
            <button type="button" onClick={() => setRetry((value) => value + 1)} className="pressable rounded-sm px-1 text-action-fg hover:bg-raised">
              {t("重新讀取")}
            </button>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}
