"""序列片段效果（``media.sequence.v1`` 的 ``clips[].effects``，契約 ``MediaClipEffects``）：解析、幀數與 FFmpeg filtergraph.

純函式，不啟動任何程序；``media.concat`` 在序列含有效果時使用這裡的 filtergraph，沒有效果時沿用原本的接合圖
（輸出與加入效果之前完全相同）。

幀數規則（Studio 前端 ``features/studio/effects/core.ts`` 用同一套公式；匯出後以 ffprobe 實際數 frame 比對）：

- 片段素材幀數 n=裁切後幀數（已換算成序列影格率）；速度 p=``speed_percent``。
  套用速度後的幀數 r=max(1, floor(n×100／p))；第 k 個輸出幀取素材第 floor(k×p／100) 幀。
  FFmpeg：``settb=AVTB,setpts=(PTS-STARTPTS)*100/p+0.499/F/TB,fps=F``（0.499 幀的偏移讓 fps 的就近取整落在
  floor），之後 ``tpad``（複製最後一幀）+``trim`` 把每段固定成 r 幀。
- 停格 ``hold``：開頭重複第一幀 hold.start 幀、結尾重複最後一幀 hold.end 幀（``tpad`` clone），片段長度
  m=r+hold.start+hold.end；停格期間的聲音是靜音（``adelay`` 與 ``apad``）。淡入淡出、文字與轉場都以 m 計算。
- 動畫拍數 ``frame_step`` s：套用速度後以 ``framestep=s`` 取每 s 幀的第一幀，再以 ``fps=F`` 重複補回，長度仍是 r。
- 鏡頭 ``camera``：``zoom_percent`` 以中心裁切後縮放回序列尺寸；``shake_px``／``shake_frames`` 以 ``crop`` 的逐幀
  x／y 運算式從片段第一幀起震動、線性衰減（裁切留邊 shake_px，再縮放回序列尺寸）。
- 色彩 ``invert``：``negate``（先反相再套 ``eq``）。
- 衝擊格 ``impact``：片段開頭 frames 幀以 FFmpeg 的 timeline 選項（``enable='lt(n,F)'``）換成黑白負片高對比
  （``negate``+``hue=s=0``+``eq=contrast``）、全白或全黑（``drawbox`` 填滿）；長度不變。
- 非 cut 的轉場與下一段重疊 D 幀（``xfade``／``acrossfade``），序列總長=Σm-ΣD。push／slide／whip／wipe／zoom
  在這個片段序列以最接近的 xfade 近似（等速、硬邊、無甩鏡模糊）；多軌時間軸匯出（``composition_video``）精確繪製。
- 聲音每段固定為 round(m×48000／F) 個 sample（``apad``+``atrim``），轉場以 sample 為單位精準重疊；
  變速用 ``atempo``（不變調）。
- 文字標題由瀏覽器排版成序列尺寸的透明 PNG，這裡只負責 ``overlay``（不依賴 drawtext：部分 FFmpeg 建置沒有 libfreetype）。
- 序列聲音改用外部音軌（``audio_track``，見 ``phasyn_media.soundtrack``）時以 ``filter_graph(audio=False)`` 只產生影片；
  影片部分（幀數、轉場、效果）與有聲音時完全相同。
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from fractions import Fraction
from typing import Any

from ._validate import filter_number as _num, invalid as _invalid, number as _number


_IDENTITY_PERCENT = 100
_MAX_TITLE_LENGTH = 200


AUDIO_RATE = 48000
SPEED_MIN = 50
SPEED_MAX = 200
VOLUME_MIN_DB = -60.0
VOLUME_MAX_DB = 12.0
FADE_MAX_FRAMES = 1000
TRANSITION_MAX_FRAMES = 240
TITLE_MAX_FRAME = 100000
HOLD_MAX_FRAMES = 240
FRAME_STEP_MAX = 4
ZOOM_MIN = 100
ZOOM_MAX = 200
SHAKE_MAX_PX = 64
SHAKE_MAX_FRAMES = 1000
IMPACT_MAX_FRAMES = 12
IMPACT_STYLES = ("negative", "white", "black")
# 黑白負片衝擊格的對比倍率
_IMPACT_CONTRAST = "1.8"
# 速度變更後 fps 的自然輸出可能比 m 多一幀或（素材缺幀時）少一兩幀；tpad 最多補這麼多幀，再由 trim 固定成 m 幀
_TAIL_PAD_FRAMES = 2
# setpts 的取樣偏移（幀）：fps 以就近取整轉換時間，偏移 0.499 幀讓第 k 個輸出幀落在素材第 floor(k×p／100) 幀
_RETIME_OFFSET_FRAMES = Fraction(499, 1000)
# 震動的 x／y 頻率（每幀弧度；兩個互質的無理數倍率讓軌跡不重複、看起來像手持衝擊）
_SHAKE_X_RATE = "2.39"
_SHAKE_Y_RATE = "3.17"

TRANSITION_LABELS = {
    "crossfade": "交叉溶接",
    "dip_to_black": "暗場轉場",
    "dip_to_white": "閃白轉場",
    "push": "推移",
    "slide": "滑入",
    "whip": "甩鏡",
    "wipe": "擦除",
    "zoom": "縮放轉場",
}
# Where a moving transition goes (``direction``), how its movement eases and how soft a wipe's edge is.
EDGE_DIRECTIONS = ("left", "right", "up", "down")
ZOOM_DIRECTIONS = ("in", "out")
TRANSITION_DIRECTIONS: dict[str, tuple[str, ...]] = {
    "push": EDGE_DIRECTIONS,
    "slide": EDGE_DIRECTIONS,
    "whip": EDGE_DIRECTIONS,
    "wipe": EDGE_DIRECTIONS,
    "zoom": ZOOM_DIRECTIONS,
}
EASINGS = ("linear", "ease_in", "ease_out", "ease_in_out")
DEFAULT_EASING = "ease_in_out"
DEFAULT_WIPE_SOFTNESS = 0.05
WIPE_SOFTNESS_MAX = 0.5
_DIPS = ("dip_to_black", "dip_to_white")
_XFADE = {"crossfade": "fade", "dip_to_black": "fadeblack", "dip_to_white": "fadewhite"}
# The clip-list sequence (no timeline) joins with FFmpeg's own xfade: a moving transition is its nearest xfade
# (linear, a hard wipe edge, no whip blur, a zoom out as a cross-fade). The timeline export draws them exactly.
_XFADE_MOVES = {"push": "slide", "whip": "slide", "slide": "cover", "wipe": "wipe"}
_EFFECT_KEYS = frozenset(
    {
        "speed_percent",
        "volume_db",
        "mute",
        "fade",
        "color",
        "title",
        "transition_out",
        "hold",
        "frame_step",
        "camera",
        "impact",
    }
)
_FADE_KEYS = ("video_in", "video_out", "audio_in", "audio_out")
_COLOR_KEYS = ("brightness", "contrast", "saturation")
_COLOR_FIELDS = (*_COLOR_KEYS, "invert")
_HOLD_KEYS = ("start", "end")
_CAMERA_KEYS = ("zoom_percent", "shake_px", "shake_frames")
_TITLE_KEYS = frozenset(
    {
        "text",
        "position",
        "size",
        "start_frame",
        "end_frame",
        "image",
        "image_key",
        "style",
    }
)
FITS = ("contain", "cover")


@dataclass(frozen=True)
class Fade:
    """Video and audio fade lengths, measured in frames."""

    video_in: int = 0
    video_out: int = 0
    audio_in: int = 0
    audio_out: int = 0

    @property
    def is_identity(self) -> bool:
        """Return whether applying these settings leaves the input unchanged."""
        return not (self.video_in or self.video_out or self.audio_in or self.audio_out)


@dataclass(frozen=True)
class Color:
    """Color adjustment values for a single clip."""

    brightness: float = 0.0
    contrast: float = 1.0
    saturation: float = 1.0
    invert: bool = False

    @property
    def is_identity(self) -> bool:
        """Return whether applying these settings leaves the input unchanged."""
        return not self.invert and self.eq_identity

    @property
    def eq_identity(self) -> bool:
        """Eq 的三個數值都是預設值（不需要 eq 濾鏡）."""
        return self.brightness == 0 and self.contrast == 1 and self.saturation == 1


@dataclass(frozen=True)
class Hold:
    """停格：開頭重複第一幀 start 幀、結尾重複最後一幀 end 幀."""

    start: int = 0
    end: int = 0

    @property
    def is_identity(self) -> bool:
        """Return whether applying these settings leaves the input unchanged."""
        return not (self.start or self.end)


@dataclass(frozen=True)
class Camera:
    """鏡頭運動：中心推近（zoom_percent）與從片段開頭起線性衰減的衝擊震動（shake_px、shake_frames）."""

    zoom_percent: int = 100
    shake_px: int = 0
    shake_frames: int = 0

    @property
    def shakes(self) -> bool:
        """Return whether the camera has an animated shake."""
        return self.shake_px > 0 and self.shake_frames > 0

    @property
    def is_identity(self) -> bool:
        """Return whether applying these settings leaves the input unchanged."""
        return self.zoom_percent == _IDENTITY_PERCENT and not self.shakes


@dataclass(frozen=True)
class Impact:
    """衝擊格：片段開頭 frames 幀換成黑白負片（negative）、全白（white）或全黑（black）."""

    frames: int
    style: str


@dataclass(frozen=True)
class Title:
    """瀏覽器排版好的文字圖層：image 是序列尺寸的透明 PNG，疊在片段的 [start_frame, end_frame) 幀."""

    image: Mapping[str, Any]
    start_frame: int
    end_frame: int | None
    text: str


@dataclass(frozen=True)
class Transition:
    """轉場（cut 以 None 表示）。push／slide／whip／wipe／zoom 會移動或揭開畫面：direction、easing、softness（wipe）."""

    kind: str  # crossfade | dip_to_black | dip_to_white | push | slide | whip | wipe | zoom
    frames: int
    direction: str | None = (
        None  # left／right／up／down（zoom：in／out）；不移動的轉場是 None
    )
    easing: str = DEFAULT_EASING
    softness: float = DEFAULT_WIPE_SOFTNESS

    @property
    def dips(self) -> bool:
        """暗場／閃白：聲音前半淡出、後半淡入；其他轉場的聲音一律交叉淡化."""
        return self.kind in _DIPS

    def as_dict(self) -> dict[str, Any]:
        """Return the serializable field values."""
        out: dict[str, Any] = {"kind": self.kind, "frames": self.frames}
        if self.direction is not None:
            out |= {"direction": self.direction, "easing": self.easing}
        if self.kind == "wipe":
            out["softness"] = self.softness
        return out


@dataclass(frozen=True)
class ClipEffects:
    """Validated visual, motion, and temporal effects on a clip."""

    speed_percent: int = 100
    volume_db: float = 0.0
    mute: bool = False
    fade: Fade = field(default_factory=Fade)
    color: Color = field(default_factory=Color)
    title: Title | None = None
    transition_out: Transition | None = None
    hold: Hold = field(default_factory=Hold)
    frame_step: int = 1
    camera: Camera = field(default_factory=Camera)
    impact: Impact | None = None

    @property
    def is_identity(self) -> bool:
        """全部是預設值（等同沒有效果）."""
        return (
            self.speed_percent == _IDENTITY_PERCENT
            and self.volume_db == 0
            and not self.mute
            and self.fade.is_identity
            and self.color.is_identity
            and self.title is None
            and self.transition_out is None
            and self.hold.is_identity
            and self.frame_step == 1
            and self.camera.is_identity
            and self.impact is None
        )

    def as_dict(self) -> dict[str, Any]:
        """正規化後的效果（記錄在 actual_settings；只列出非預設值）."""
        out: dict[str, Any] = {}
        if self.speed_percent != _IDENTITY_PERCENT:
            out["speed_percent"] = self.speed_percent
        if self.volume_db != 0:
            out["volume_db"] = self.volume_db
        if self.mute:
            out["mute"] = True
        if not self.fade.is_identity:
            out["fade"] = {
                key: getattr(self.fade, key)
                for key in _FADE_KEYS
                if getattr(self.fade, key)
            }
        if not self.color.is_identity:
            out["color"] = {key: getattr(self.color, key) for key in _COLOR_KEYS}
            if self.color.invert:
                out["color"]["invert"] = True
        if not self.hold.is_identity:
            out["hold"] = {
                key: getattr(self.hold, key)
                for key in _HOLD_KEYS
                if getattr(self.hold, key)
            }
        if self.frame_step != 1:
            out["frame_step"] = self.frame_step
        _append_visual_effects(self, out)
        return out


# --------------------------------------------------------------------------- parsing


def _int(value: Any, path: str, lo: int, hi: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise _invalid(path, "必須是整數")
    if not lo <= value <= hi:
        raise _invalid(path, f"必須在 {lo}\u2013{hi} 之間（目前 {value}）")
    return value


def _object(
    value: Any, path: str, allowed: frozenset[str] | tuple[str, ...]
) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise _invalid(path, "必須是 object")
    unknown = sorted(str(key) for key in value if key not in allowed)
    if unknown:
        raise _invalid(path, f"不支援的欄位 {', '.join(unknown)}")
    return value


def _title(value: Any, path: str) -> Title:
    doc = _object(value, path, _TITLE_KEYS)
    text = doc.get("text")
    if not isinstance(text, str) or not 1 <= len(text) <= _MAX_TITLE_LENGTH:
        raise _invalid(f"{path}.text", "必須是 1\u2013200 字的字串")
    image = doc.get("image")
    if image is None:
        raise _invalid(
            f"{path}.image", "文字圖層尚未產生（Studio 會把文字排版成 PNG 後再匯出）"
        )
    if not isinstance(image, Mapping) or not image.get("file_id"):
        raise _invalid(f"{path}.image", "必須是 FileRef")
    if str(image.get("media_type") or "").split(";")[0].strip().lower() != "image/png":
        raise _invalid(
            f"{path}.image", f"必須是 image/png（目前 {image.get('media_type')}）"
        )
    start = _int(doc.get("start_frame", 0), f"{path}.start_frame", 0, TITLE_MAX_FRAME)
    raw_end = doc.get("end_frame")
    end = (
        None
        if raw_end is None
        else _int(raw_end, f"{path}.end_frame", 1, TITLE_MAX_FRAME)
    )
    if end is not None and end <= start:
        raise _invalid(f"{path}.end_frame", f"必須大於 start_frame（{start}）")
    return Title(image=dict(image), start_frame=start, end_frame=end, text=text)


def _transition(value: Any, path: str) -> Transition | None:
    doc = _object(value, path, ("kind", "frames", "direction", "easing", "softness"))
    kind = doc.get("kind")
    if kind == "cut":
        if "frames" in doc:
            raise _invalid(f"{path}.frames", "cut 沒有長度")
        _object(doc, path, ("kind",))
        return None
    if kind not in TRANSITION_LABELS:
        raise _invalid(
            f"{path}.kind",
            "必須是 cut、crossfade、dip_to_black、dip_to_white、push、slide、whip、wipe 或 zoom",
        )
    frames = _int(doc.get("frames"), f"{path}.frames", 1, TRANSITION_MAX_FRAMES)
    directions = TRANSITION_DIRECTIONS.get(str(kind))
    if directions is None:
        _object(doc, path, ("kind", "frames"))
        return Transition(kind=str(kind), frames=frames)
    _object(
        doc,
        path,
        (
            "kind",
            "frames",
            "direction",
            "easing",
            *(("softness",) if kind == "wipe" else ()),
        ),
    )
    direction = doc.get("direction")
    if kind == "zoom" and direction not in directions:
        raise _invalid(f"{path}.direction", "必須是 in 或 out")
    if direction not in directions:
        raise _invalid(f"{path}.direction", "必須是 left、right、up 或 down")
    easing = doc.get("easing", DEFAULT_EASING)
    if easing not in EASINGS:
        raise _invalid(
            f"{path}.easing", "必須是 linear、ease_in、ease_out 或 ease_in_out"
        )
    softness = _number(
        doc.get("softness", DEFAULT_WIPE_SOFTNESS),
        f"{path}.softness",
        0,
        WIPE_SOFTNESS_MAX,
    )
    return Transition(str(kind), frames, str(direction), str(easing), softness)


def _xfade(transition: Transition) -> str:
    """The FFmpeg xfade a clip-list sequence joins two clips with (see ``_XFADE_MOVES``)."""
    if transition.direction is None:
        return _XFADE[transition.kind]
    if transition.kind == "zoom":
        return "zoomin" if transition.direction == "in" else "fade"
    return _XFADE_MOVES[transition.kind] + transition.direction


def _color(value: Any, path: str) -> Color:
    doc = _object(value, path, _COLOR_FIELDS)
    invert = doc.get("invert", False)
    if not isinstance(invert, bool):
        raise _invalid(f"{path}.invert", "必須是 true 或 false")
    return Color(
        brightness=_number(doc.get("brightness", 0), f"{path}.brightness", -1, 1),
        contrast=_number(doc.get("contrast", 1), f"{path}.contrast", 0, 3),
        saturation=_number(doc.get("saturation", 1), f"{path}.saturation", 0, 3),
        invert=invert,
    )


def _impact(value: Any, path: str) -> Impact:
    doc = _object(value, path, ("frames", "style"))
    style = doc.get("style")
    if style not in IMPACT_STYLES:
        raise _invalid(f"{path}.style", "必須是 negative、white 或 black")
    return Impact(
        frames=_int(doc.get("frames"), f"{path}.frames", 1, IMPACT_MAX_FRAMES),
        style=str(style),
    )


def _camera(value: Any, path: str) -> Camera:
    doc = _object(value, path, _CAMERA_KEYS)
    return Camera(
        zoom_percent=_int(
            doc.get("zoom_percent", 100), f"{path}.zoom_percent", ZOOM_MIN, ZOOM_MAX
        ),
        shake_px=_int(doc.get("shake_px", 0), f"{path}.shake_px", 0, SHAKE_MAX_PX),
        shake_frames=_int(
            doc.get("shake_frames", 0), f"{path}.shake_frames", 0, SHAKE_MAX_FRAMES
        ),
    )


def parse_effects(value: Any, *, path: str = "effects") -> ClipEffects | None:
    """解析一個片段的 ``effects``；缺少或全部是預設值時回傳 None（=沒有效果）。不合法時丟出 INVALID_ARGUMENT."""
    if value is None:
        return None
    doc = _object(value, path, _EFFECT_KEYS)
    speed = _int(
        doc.get("speed_percent", 100), f"{path}.speed_percent", SPEED_MIN, SPEED_MAX
    )
    volume = _number(
        doc.get("volume_db", 0), f"{path}.volume_db", VOLUME_MIN_DB, VOLUME_MAX_DB
    )
    mute = doc.get("mute", False)
    if not isinstance(mute, bool):
        raise _invalid(f"{path}.mute", "必須是 true 或 false")
    fade_doc = _object(doc.get("fade", {}), f"{path}.fade", _FADE_KEYS)
    fade = Fade(
        **{
            key: _int(fade_doc.get(key, 0), f"{path}.fade.{key}", 0, FADE_MAX_FRAMES)
            for key in _FADE_KEYS
        }
    )
    color = _color(doc.get("color", {}), f"{path}.color")
    title = (
        _title(doc["title"], f"{path}.title") if doc.get("title") is not None else None
    )
    transition = (
        _transition(doc["transition_out"], f"{path}.transition_out")
        if doc.get("transition_out") is not None
        else None
    )
    hold_doc = _object(doc.get("hold", {}), f"{path}.hold", _HOLD_KEYS)
    hold = Hold(
        **{
            key: _int(hold_doc.get(key, 0), f"{path}.hold.{key}", 0, HOLD_MAX_FRAMES)
            for key in _HOLD_KEYS
        }
    )
    frame_step = _int(doc.get("frame_step", 1), f"{path}.frame_step", 1, FRAME_STEP_MAX)
    camera = _camera(doc.get("camera", {}), f"{path}.camera")
    impact = (
        _impact(doc["impact"], f"{path}.impact")
        if doc.get("impact") is not None
        else None
    )
    effects = ClipEffects(
        speed_percent=speed,
        volume_db=volume,
        mute=mute,
        fade=fade,
        color=color,
        title=title,
        transition_out=transition,
        hold=hold,
        frame_step=frame_step,
        camera=camera,
        impact=impact,
    )
    return None if effects.is_identity else effects


# --------------------------------------------------------------------------- frame math


def retimed_frames(frames: int, speed_percent: int = 100) -> int:
    """套用速度後的片段幀數：max(1, floor(frames×100／speed_percent))."""
    if frames <= 0:
        return 0
    return max(1, frames * 100 // speed_percent)


def source_frame_at(output_frame: int, speed_percent: int = 100) -> int:
    """套用速度後的第 k 幀取自素材（裁切後）的第幾幀."""
    return output_frame * speed_percent // 100


def clip_frames(frames: int, effects: ClipEffects | None) -> int:
    """片段在序列上的幀數 m：套用速度後的幀數+開頭與結尾的停格（前端 core.ts 的 clipFramesOut 用同一個公式）."""
    if effects is None:
        return retimed_frames(frames)
    if frames <= 0:
        return 0
    return (
        retimed_frames(frames, effects.speed_percent)
        + effects.hold.start
        + effects.hold.end
    )


def samples_for(frames: int, fps: Fraction, rate: int = AUDIO_RATE) -> int:
    """Frames 幀在 fps 下對應的 sample 數（四捨五入）."""
    return math.floor(Fraction(frames) * rate / fps + Fraction(1, 2))


@dataclass(frozen=True)
class PlannedClip:
    """A clip with its resolved duration and transition boundaries."""

    index: int
    source_frames: int  # n：裁切後、換算成序列影格率的幀數
    frames: int  # m：套用速度後的幀數
    start_frame: int  # 在輸出序列上的起點（幀）
    samples: int  # 這段聲音的 sample 數（48 kHz）
    effects: ClipEffects | None
    transition_in: Transition | None  # 上一段接進來的轉場


@dataclass(frozen=True)
class SequencePlan:
    """The ordered clips and output frame count for a sequence."""

    clips: tuple[PlannedClip, ...]
    total_frames: int
    # 以非 cut 轉場相連的片段（每組在 filtergraph 內以 xfade 串接，各組再以 concat 接合）
    groups: tuple[tuple[int, ...], ...]


def plan_sequence(
    source_frames: Sequence[int], effects: Sequence[ClipEffects | None], fps: Fraction
) -> SequencePlan:
    """計算每段的輸出幀數、序列總長與轉場分組，並檢查效果與片段長度是否相容（INVALID_ARGUMENT）."""
    if len(source_frames) != len(effects):
        raise ValueError("source_frames 與 effects 數量不同")
    count = len(source_frames)
    lengths = [clip_frames(n, fx) for n, fx in zip(source_frames, effects, strict=True)]
    transitions: list[Transition | None] = [
        fx.transition_out if fx else None for fx in effects
    ]
    _check_transitions(transitions, lengths)
    _check_clip_extents(effects, transitions, lengths)
    planned: list[PlannedClip] = []
    groups: list[tuple[int, ...]] = []
    current: list[int] = []
    cursor = 0
    for i in range(count):
        incoming_transition = transitions[i - 1] if i > 0 else None
        if incoming_transition is not None:
            cursor -= incoming_transition.frames
            current.append(i)
        else:
            if current:
                groups.append(tuple(current))
            current = [i]
        planned.append(
            PlannedClip(
                index=i,
                source_frames=source_frames[i],
                frames=lengths[i],
                start_frame=cursor,
                samples=samples_for(lengths[i], fps),
                effects=effects[i],
                transition_in=incoming_transition,
            )
        )
        cursor += lengths[i]
    if current:
        groups.append(tuple(current))
    return SequencePlan(clips=tuple(planned), total_frames=cursor, groups=tuple(groups))


# --------------------------------------------------------------------------- filtergraph


@dataclass(frozen=True)
class ClipSource:
    """一個片段在 FFmpeg 命令中的來源：輸入編號、素材裁切範圍（素材幀，out 不含）、素材影格率、是否有音軌."""

    input_index: int
    in_frame: int
    out_frame: int
    fps: Fraction
    has_audio: bool


def _seconds(frames: int, fps: Fraction) -> str:
    return f"{float(Fraction(frames) / fps):.6f}"


def fit_chain(width: int, height: int, fit: str | None) -> list[str]:
    """把片段縮放到序列尺寸：None=原本的行為（等比縮小+黑邊，預設縮放演算法）；contain／cover 使用 lanczos."""
    if fit is None:
        return [
            f"scale={width}:{height}:force_original_aspect_ratio=decrease",
            f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black",
        ]
    if fit == "cover":
        return [
            f"scale={width}:{height}:force_original_aspect_ratio=increase:flags=lanczos",
            f"crop={width}:{height}",
        ]
    return [
        f"scale={width}:{height}:force_original_aspect_ratio=decrease:flags=lanczos",
        f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black",
    ]


def _even(value: float) -> int:
    return max(2, int(value) // 2 * 2)


def camera_chain(
    camera: Camera, *, width: int, height: int, clock: str = "n", flags: str = "lanczos"
) -> list[str]:
    """推近與震動：以中心裁切（留震動的邊）再縮放回序列尺寸；震動以 crop 的逐幀 x／y 運算式在 shake_frames 幀內衰減.

    clock：片段第幾幀的運算式（預設=濾鏡自己的幀序號 n；多軌匯出從片段中途開始時傳入 ``(n+起點)``）。
    """
    if camera.is_identity:
        return []
    margin = camera.shake_px if camera.shakes else 0
    crop_w = _even(width * 100 / camera.zoom_percent - 2 * margin)
    crop_h = _even(crop_w * height / width)
    base_x = (width - crop_w) // 2
    base_y = (height - crop_h) // 2
    if camera.shakes:
        amp_x = min(margin, base_x)
        amp_y = min(round(margin * height / width), base_y)
        decay = f"max(0,1-{clock}/{camera.shake_frames})"
        x = f"'{base_x}+{amp_x}*sin({clock}*{_SHAKE_X_RATE})*{decay}'"
        y = f"'{base_y}+{amp_y}*cos({clock}*{_SHAKE_Y_RATE})*{decay}'"
    else:
        x, y = str(base_x), str(base_y)
    return [
        f"crop=w={crop_w}:h={crop_h}:x={x}:y={y}",
        f"scale={width}:{height}:flags={flags}",
        "setsar=1",
    ]


def video_chain(  # noqa: PLR0913 - Preserve the public keyword signature.
    source: ClipSource,
    clip: PlannedClip,
    *,
    width: int,
    height: int,
    fps: Fraction,
    fit: str | None = None,
    normalized: bool = False,
) -> list[str]:
    """Build the FFmpeg filters for the clip effects."""
    rate = f"{fps.numerator}/{fps.denominator}"
    fx = clip.effects
    speed = fx.speed_percent if fx else 100
    step = fx.frame_step if fx else 1
    hold = fx.hold if fx else Hold()
    retimed = clip.frames - hold.start - hold.end
    timing = (
        [
            "setpts=PTS-STARTPTS",
            f"fps={rate}",
            f"trim=start_frame={source.in_frame}:end_frame={source.out_frame}",
            "setpts=PTS-STARTPTS",
        ]
        if normalized
        else [
            f"trim=start_frame={source.in_frame}:end_frame={source.out_frame}",
            "setpts=PTS-STARTPTS",
            f"fps={rate}",
        ]
    )
    parts = [
        *timing,
        *fit_chain(width, height, fit),
        "setsar=1",
        "format=yuv420p",
    ]
    if speed != _IDENTITY_PERCENT:
        offset = _RETIME_OFFSET_FRAMES / fps
        parts += [
            "settb=AVTB",
            f"setpts=(PTS-STARTPTS)*100/{speed}+{_num(float(offset))}/TB",
            f"fps={rate}",
        ]
    if step > 1:
        # 有限動畫：留下每 step 幀的第一幀，fps 再把它重複補回（長度不變；尾端缺的幀由下面的 tpad 補）
        parts += [f"framestep=step={step}", f"fps={rate}"]
    parts += [
        f"tpad=stop_mode=clone:stop={_TAIL_PAD_FRAMES + step - 1}",
        f"trim=end_frame={retimed}",
        "setpts=PTS-STARTPTS",
    ]
    if not hold.is_identity:
        parts += [
            f"tpad=start_mode=clone:start={hold.start}:stop_mode=clone:stop={hold.end}",
            "setpts=PTS-STARTPTS",
            f"trim=end_frame={clip.frames}",
            "setpts=PTS-STARTPTS",
        ]
    if fx is not None:
        parts += camera_chain(fx.camera, width=width, height=height)
        if fx.color.invert:
            parts.append("negate")
        if not fx.color.eq_identity:
            c = fx.color
            parts.append(
                f"eq=brightness={_num(c.brightness)}:contrast={_num(c.contrast)}:saturation={_num(c.saturation)}"
            )
        if fx.impact is not None:
            parts += impact_chain(fx.impact)
    return parts


def impact_chain(impact: Impact, *, clock: str = "n") -> list[str]:
    """衝擊格：只在片段開頭 frames 幀生效（timeline 選項 enable），其餘幀原樣通過。clock 同 camera_chain."""
    enable = f"enable='lt({clock},{impact.frames})'"
    if impact.style == "negative":
        return [
            f"negate={enable}",
            f"hue=s=0:{enable}",
            f"eq=contrast={_IMPACT_CONTRAST}:{enable}",
        ]
    color = "white" if impact.style == "white" else "black"
    return [f"drawbox=x=0:y=0:w=iw:h=ih:color={color}:t=fill:{enable}"]


def _fade_chain(clip: PlannedClip) -> list[str]:
    fx = clip.effects
    if fx is None:
        return []
    out: list[str] = []
    if fx.fade.video_in:
        out.append(f"fade=t=in:s=0:n={fx.fade.video_in}")
    if fx.fade.video_out:
        # 淡出的最後一幀全黑：fade 在 s+n 幀變成全黑，所以從 m-n-1 開始
        out.append(
            f"fade=t=out:s={clip.frames - fx.fade.video_out - 1}:n={fx.fade.video_out}"
        )
    return out


def audio_chain(
    source: ClipSource, clip: PlannedClip, fps: Fraction
) -> tuple[str, str | None]:
    """回傳（聲音鏈，補靜音的說明或 None）."""
    fx = clip.effects
    total = clip.samples
    fmt = "aformat=sample_fmts=fltp:channel_layouts=stereo"
    note = None
    if source.has_audio:
        start_s = Fraction(source.in_frame) / source.fps
        dur_s = Fraction(source.out_frame - source.in_frame) / source.fps
        parts = [
            f"[{source.input_index}:a:0]atrim=start={float(start_s):.6f}:duration={float(dur_s):.6f}",
            "asetpts=PTS-STARTPTS",
            f"aresample={AUDIO_RATE}",
            fmt,
        ]
        if fx is not None and fx.speed_percent != _IDENTITY_PERCENT:
            parts.append(f"atempo={_num(fx.speed_percent / 100)}")
    else:
        parts = [f"anullsrc=r={AUDIO_RATE}:cl=stereo", f"atrim=end_sample={total}", fmt]
        note = f"片段 {clip.index + 1} 沒有音軌：以 {total / AUDIO_RATE:.3f} 秒靜音補齊"
    if fx is not None and fx.mute:
        parts.append("volume=0")
    elif fx is not None and fx.volume_db != 0:
        parts.append(f"volume={_num(fx.volume_db)}dB")
    if source.has_audio and fx is not None and fx.hold.start:
        # 開頭停格的這段時間是靜音：聲音整體往後延（以 sample 計，與影片的停格幀數對齊）；結尾停格由 apad 補靜音
        parts.append(f"adelay=delays={samples_for(fx.hold.start, fps)}S:all=1")
    parts += [
        f"apad=whole_len={total}",
        f"atrim=end_sample={total}",
        "asetpts=PTS-STARTPTS",
    ]
    if fx is not None and fx.fade.audio_in:
        parts.append(
            f"afade=t=in:ss=0:ns={min(total, samples_for(fx.fade.audio_in, fps))}"
        )
    if fx is not None and fx.fade.audio_out:
        length = min(total, samples_for(fx.fade.audio_out, fps))
        parts.append(f"afade=t=out:ss={total - length}:ns={length}")
    return ",".join(parts), note


def filter_graph(  # noqa: PLR0913 - Preserve the public keyword signature.
    sources: Sequence[ClipSource],
    plan: SequencePlan,
    *,
    width: int,
    height: int,
    fps: Fraction,
    title_inputs: Mapping[int, int] | None = None,
    audio: bool = True,
    fit: str | None = None,
) -> tuple[str, list[str]]:
    """含效果的序列 filtergraph（輸出標籤 ``[v]``、``[a]``）與處理說明.

    title_inputs：片段序號 → 文字圖層 PNG 的 FFmpeg 輸入編號（每個有 title 的片段都必須提供）。
    audio=False：只產生影片（輸出標籤只有 ``[v]``；序列聲音改由外部音軌提供），片段的聲音與聲音效果都不處理。
    fit：片段縮放到序列尺寸的方式（``MediaSequence.fit``；None=原本的等比縮小+黑邊）。
    """
    if len(sources) != len(plan.clips):
        raise ValueError("sources 與 plan 片段數不同")
    titles = dict(title_inputs or {})
    parts: list[str] = []
    notes: list[str] = []
    for source, clip in zip(sources, plan.clips, strict=True):
        i = clip.index
        video = ",".join(
            video_chain(source, clip, width=width, height=height, fps=fps, fit=fit)
        )
        fades = _fade_chain(clip)
        fx = clip.effects
        if fx is not None and fx.title is not None:
            if i not in titles:
                raise ValueError(f"片段 {i} 的文字圖層沒有對應的輸入")
            end = clip.frames if fx.title.end_frame is None else fx.title.end_frame
            parts.append(
                f"[{source.input_index}:V:0]{video}[base{i}]"
            )  # V: never an attached cover picture
            parts.append(
                f"[{titles[i]}:v:0]scale={width}:{height},format=rgba[title{i}]"
            )
            tail = ",".join(["format=yuv420p", *fades])
            parts.append(
                f"[base{i}][title{i}]overlay=x=0:y=0:eof_action=repeat:"
                f"enable='between(n,{fx.title.start_frame},{end - 1})',{tail}[v{i}]"
            )
        else:
            parts.append(f"[{source.input_index}:V:0]{','.join([video, *fades])}[v{i}]")
        if audio:
            chain, note = audio_chain(source, clip, fps)
            parts.append(f"{chain}[a{i}]")
            if note:
                notes.append(note)
        _append_retiming_notes(notes, clip)
    _join_clip_groups(plan, fps, parts, notes, audio=audio)
    return ";".join(parts), notes


__all__ = [
    "AUDIO_RATE",
    "DEFAULT_EASING",
    "DEFAULT_WIPE_SOFTNESS",
    "EASINGS",
    "EDGE_DIRECTIONS",
    "FITS",
    "TRANSITION_DIRECTIONS",
    "TRANSITION_LABELS",
    "WIPE_SOFTNESS_MAX",
    "ZOOM_DIRECTIONS",
    "Camera",
    "ClipEffects",
    "ClipSource",
    "Color",
    "Fade",
    "Hold",
    "Impact",
    "PlannedClip",
    "SequencePlan",
    "Title",
    "Transition",
    "audio_chain",
    "camera_chain",
    "clip_frames",
    "filter_graph",
    "fit_chain",
    "impact_chain",
    "parse_effects",
    "plan_sequence",
    "retimed_frames",
    "samples_for",
    "source_frame_at",
    "video_chain",
]


def _append_visual_effects(effect: ClipEffects, out: dict[str, Any]) -> None:
    if not effect.camera.is_identity:
        camera: dict[str, int] = {}
        if effect.camera.zoom_percent != _IDENTITY_PERCENT:
            camera["zoom_percent"] = effect.camera.zoom_percent
        if effect.camera.shakes:
            camera["shake_px"] = effect.camera.shake_px
            camera["shake_frames"] = effect.camera.shake_frames
        out["camera"] = camera
    if effect.impact is not None:
        out["impact"] = {"frames": effect.impact.frames, "style": effect.impact.style}
    if effect.title is not None:
        out["title"] = {
            "text": effect.title.text,
            "start_frame": effect.title.start_frame,
            "end_frame": effect.title.end_frame,
            "file_id": effect.title.image.get("file_id"),
            "sha256": effect.title.image.get("sha256"),
        }
    if effect.transition_out is not None:
        out["transition_out"] = effect.transition_out.as_dict()


def _check_transitions(
    transitions: Sequence[Transition | None], lengths: Sequence[int]
) -> None:
    count = len(lengths)
    if count and transitions[-1] is not None:
        raise _invalid(
            f"sequence.clips[{count - 1}].effects.transition_out",
            "序列最後一個片段沒有下一段，只能是 cut",
        )
    for i, transition in enumerate(transitions[:-1]):
        if transition is None:
            continue
        a, b = lengths[i], lengths[i + 1]
        if transition.frames > min(a, b):
            raise _invalid(
                f"sequence.clips[{i}].effects.transition_out.frames",
                f"轉場 {transition.frames} 幀超過相鄰片段的長度（本段 {a} 幀、下一段 {b} 幀）",
            )


def _check_clip_extents(
    effects: Sequence[ClipEffects | None],
    transitions: Sequence[Transition | None],
    lengths: Sequence[int],
) -> None:
    for i in range(len(lengths)):
        m = lengths[i]
        previous = transitions[i - 1] if i > 0 else None
        current_out = transitions[i]
        incoming = previous.frames if previous is not None else 0
        outgoing = current_out.frames if current_out is not None else 0
        if incoming + outgoing > m:
            raise _invalid(
                f"sequence.clips[{i}].effects.transition_out.frames",
                f"片段 {i + 1} 的進場轉場 {incoming} 幀\uff0b出場轉場 {outgoing} 幀超過片段長度 {m} 幀",
            )
        fx = effects[i]
        if fx is None:
            continue
        path = f"sequence.clips[{i}].effects"
        fade = fx.fade
        if fade.video_in + fade.video_out > m or fade.video_out > m - 1:
            raise _invalid(
                f"{path}.fade",
                f"影片淡入 {fade.video_in} 幀\uff0b淡出 {fade.video_out} 幀超過片段長度 {m} 幀（淡出最多 {m - 1} 幀）",
            )
        if fade.audio_in + fade.audio_out > m:
            raise _invalid(
                f"{path}.fade",
                f"聲音淡入 {fade.audio_in} 幀\uff0b淡出 {fade.audio_out} 幀超過片段長度 {m} 幀",
            )
        if fx.impact is not None and fx.impact.frames > m:
            raise _invalid(
                f"{path}.impact.frames",
                f"衝擊格 {fx.impact.frames} 幀超過片段長度 {m} 幀",
            )
        if fx.title is not None:
            end = m if fx.title.end_frame is None else fx.title.end_frame
            if fx.title.start_frame >= m or end > m:
                raise _invalid(
                    f"{path}.title",
                    f"文字範圍 {fx.title.start_frame}\u2013{end} 超出片段長度 {m} 幀（套用速度後）",
                )


def _append_retiming_notes(notes: list[str], clip: PlannedClip) -> None:
    i, fx = clip.index, clip.effects
    if fx is not None and fx.speed_percent != _IDENTITY_PERCENT:
        retimed = retimed_frames(clip.source_frames, fx.speed_percent)
        notes.append(
            f"片段 {i + 1} 速度 {fx.speed_percent}%：{clip.source_frames} 幀 → {retimed} 幀"
        )
    if fx is not None and not fx.hold.is_identity:
        notes.append(
            f"片段 {i + 1} 停格：開頭 {fx.hold.start} 幀、結尾 {fx.hold.end} 幀（共 {clip.frames} 幀）"
        )
    if fx is not None and fx.frame_step != 1:
        notes.append(f"片段 {i + 1} 動畫拍數：一拍{fx.frame_step}")
    if fx is not None and fx.camera.shakes:
        notes.append(
            f"片段 {i + 1} 震動 {fx.camera.shake_px} px、{fx.camera.shake_frames} 幀內衰減"
        )
    if fx is not None and fx.impact is not None:
        notes.append(
            f"片段 {i + 1} 衝擊格：開頭 {fx.impact.frames} 幀（{fx.impact.style}）"
        )


def _join_clip_groups(
    plan: SequencePlan,
    fps: Fraction,
    parts: list[str],
    notes: list[str],
    *,
    audio: bool,
) -> None:
    outputs: list[tuple[str, str]] = []
    for g, group in enumerate(plan.groups):
        first = group[0]
        video_label, audio_label = f"v{first}", f"a{first}"
        length = plan.clips[first].frames
        samples = plan.clips[first].samples
        for j in group[1:]:
            clip = plan.clips[j]
            transition = clip.transition_in
            if transition is None:  # pragma: no cover - 分組保證只有轉場相連
                raise ValueError("分組內缺少轉場")
            d = transition.frames
            overlap = min(samples, clip.samples, samples_for(d, fps))
            parts.append(
                f"[{video_label}][v{j}]xfade=transition={_xfade(transition)}:"
                f"duration={_seconds(d, fps)}:offset={_seconds(length - d, fps)}[xv{g}_{j}]"
            )
            if audio and not transition.dips:
                parts.append(
                    f"[{audio_label}][a{j}]acrossfade=ns={overlap}:c1=tri:c2=tri[xa{g}_{j}]"
                )
            elif audio:
                half = overlap // 2
                parts.append(
                    f"[{audio_label}]afade=t=out:ss={samples - overlap}:ns={max(1, half)}[dipa{g}_{j}]"
                )
                parts.append(
                    f"[a{j}]afade=t=in:ss={half}:ns={max(1, overlap - half)}[dipb{g}_{j}]"
                )
                parts.append(
                    f"[dipa{g}_{j}][dipb{g}_{j}]acrossfade=ns={overlap}:c1=nofade:c2=nofade[xa{g}_{j}]"
                )
            notes.append(
                f"片段 {j}→{j + 1}：{TRANSITION_LABELS[transition.kind]} {d} 幀（重疊）"
            )
            if transition.direction is not None:
                notes.append(
                    f"片段 {j}→{j + 1}：片段序列以 FFmpeg xfade {_xfade(transition)} 近似（等速）"
                )
            video_label, audio_label = f"xv{g}_{j}", f"xa{g}_{j}"
            length += clip.frames - d
            samples += clip.samples - overlap
        outputs.append((video_label, audio_label))
    if audio:
        joined = "".join(f"[{v}][{a}]" for v, a in outputs)
        parts.append(f"{joined}concat=n={len(outputs)}:v=1:a=1[v][a]")
    else:
        joined = "".join(f"[{v}]" for v, _a in outputs)
        parts.append(f"{joined}concat=n={len(outputs)}:v=1:a=0[v]")
