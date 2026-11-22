"""Krita actions for opening an art package and returning one chosen plate."""

from __future__ import annotations

import sys
from concurrent.futures import ThreadPoolExecutor
from http.client import HTTPException
from pathlib import Path
from zipfile import BadZipFile

from krita import Extension, Krita

# libkis has already loaded its Qt bindings. Use that same major even on a
# workstation with both PyQt versions installed.
if "PyQt5.QtCore" in sys.modules:
    from PyQt5.QtCore import QBuffer, QByteArray, QIODevice, QTimer, QUrl
    from PyQt5.QtGui import QColorSpace, QDesktopServices, QImage, QImageReader
    from PyQt5.QtWidgets import QFileDialog, QInputDialog, QMessageBox
else:
    from PyQt6.QtCore import QBuffer, QByteArray, QIODevice, QTimer, QUrl
    from PyQt6.QtGui import QColorSpace, QDesktopServices, QImage, QImageReader
    from PyQt6.QtWidgets import QFileDialog, QInputDialog, QMessageBox

from .exchange import MAX_MANIFEST, ROLES, plates, read_bundle, submit

PROFILE = "sRGB-elle-V2-srgbtrc.icc"
LABEL = "Phasyn 美術交換"
ANNOTATION = "phasyn.art.exchange-manifest.v1"
ROLE_NAMES = {"source": "來源", "mask": "遮罩", "depth": "深度", "pose": "姿態"}
FORMAT = QImage.Format
MODE = QIODevice.OpenModeFlag
SRGB = QColorSpace(QColorSpace.NamedColorSpace.SRgb)
ERRORS = (ValueError, OSError, KeyError, TypeError, RuntimeError, BadZipFile, HTTPException, RecursionError)


def layer_bytes(payload, plate):
    data = QByteArray(payload)
    stream = QBuffer(data)
    stream.open(MODE.ReadOnly)
    fmt = b"png" if plate["media_type"] == "image/png" else b"jpeg"
    reader = QImageReader(stream, fmt)
    size = reader.size()
    if (size.width(), size.height()) != (plate["width"], plate["height"]):
        raise ValueError("實際圖片與工作包畫布不同。")
    image = reader.read()
    if image.isNull() or image.depth() > 32:
        raise ValueError("無法讀取這個 8 位元圖片。")
    if image.colorSpace().isValid():
        image = image.convertedToColorSpace(SRGB)
    image = image.convertToFormat(FORMAT.Format_ARGB32)
    if image.isNull() or image.size() != size:
        raise ValueError("圖片色彩轉換失敗。")
    return QByteArray(image.constBits().asstring(image.sizeInBytes()))


def _revision(doc, role, mode, plate):
    w, h = plate["width"], plate["height"]
    if (doc.width(), doc.height()) != (w, h):
        raise ValueError("畫布尺寸已變更，無法回程至原始素材。")
    doc.refreshProjection()
    doc.waitForDone()
    if mode == "目前選區":
        selection = doc.selection()
        if role != "mask" or selection is None:
            raise ValueError("請先建立選區並選擇遮罩角色。")
        raw = bytes(selection.pixelData(0, 0, w, h))
        grayscale = True
    else:
        node = doc.activeNode() if mode == "目前圖層" else doc.rootNode()
        if node is None:
            raise ValueError("請先選擇要回傳的圖層。")
        grayscale = node.type() in {"transparencymask", "selectionmask"}
        if grayscale and role != "mask":
            raise ValueError("請為遮罩圖層選擇遮罩角色。")
        if not grayscale and (node.colorModel(), node.colorDepth(), node.colorProfile()) != ("RGBA", "U8", PROFILE):
            raise ValueError("請使用工作包原本的 8 位元 sRGB 圖層色彩空間。")
        raw = bytes(node.projectionPixelData(0, 0, w, h))
    channels = 1 if grayscale else 4
    if len(raw) != w * h * channels:
        raise ValueError("Krita 傳回的圖層像素格式不符。")
    if not grayscale and not plate["alpha_channel"] and raw[3::4].count(255) != w * h:
        raise ValueError("原素材沒有 alpha，請先將透明區域合成到實色底圖。")
    fmt = FORMAT.Format_Grayscale8 if grayscale else FORMAT.Format_ARGB32
    image = QImage(raw, w, h, w * channels, fmt).copy()
    image = image.convertToFormat(FORMAT.Format_ARGB32 if plate["alpha_channel"] else FORMAT.Format_RGB888)
    image.setColorSpace(SRGB)
    out = QBuffer()
    out.open(MODE.WriteOnly)
    if image.isNull() or not image.save(out, "PNG"):
        raise ValueError("無法編碼修訂 PNG。")
    return bytes(out.data())


class ArtExchange(Extension):
    def __init__(self, parent):
        super().__init__(parent)
        self.executor = ThreadPoolExecutor(max_workers=1)
        self.pending = None

    def setup(self):
        """Krita registers actions separately for each window."""

    def createActions(self, window):
        for key, label, callback in (
            ("phasyn_art_open", "開啟 Phasyn 美術工作包…", self.open_bundle),
            ("phasyn_art_return", "回傳修訂至 Phasyn…", self.return_plate),
        ):
            action = window.createAction(key, label, "tools/scripts")
            action.triggered.connect(lambda _checked=False, fn=callback: fn())

    def open_bundle(self):
        parent = Krita.instance().activeWindow().qwindow()
        path, _ = QFileDialog.getOpenFileName(parent, LABEL, "", "Studio 美術工作包 (*.zip)")
        if not path:
            return
        doc = None
        attached = False
        try:
            if sys.byteorder != "little":
                raise ValueError("本機像素位元序未受支援。")
            manifest, images = read_bundle(Path(path))
            media = plates(manifest)
            source = media["source"]
            w, h = source["width"], source["height"]
            app = Krita.instance()
            if PROFILE not in app.profiles("RGBA", "U8"):
                raise ValueError("Krita 缺少交換工作包需要的 8 位元 sRGB 色彩描述檔。")
            doc = app.createDocument(w, h, "Phasyn · 美術修訂", "RGBA", "U8", PROFILE, 72.0)
            if doc is None:
                raise ValueError("Krita 無法建立工作畫布。")
            root = doc.rootNode()
            for default_layer in root.childNodes():
                default_layer.setVisible(False)
            for role in ROLES:
                if role not in media:
                    continue
                layer = doc.createNode(ROLE_NAMES[role], "paintlayer")
                pixels = layer_bytes(images[role], media[role])
                if layer is None or not root.addChildNode(layer, None) or not layer.setPixelData(pixels, 0, 0, w, h):
                    raise ValueError(f"無法載入{ROLE_NAMES[role]}圖層。")
                layer.setVisible(role == "source")
                if role == "source":
                    source_layer = layer
            doc.setAnnotation(ANNOTATION, "Phasyn 原始美術交換 manifest", QByteArray(manifest))
            doc.refreshProjection()
            doc.waitForDone()
            if app.activeWindow().addView(doc) is None:
                raise ValueError("無法開啟工作包畫布。")
            attached = True
            doc.setActiveNode(source_layer)
        except ERRORS as error:
            if doc is not None and not attached:
                doc.close()
            QMessageBox.warning(parent, LABEL, str(error))

    def return_plate(self):
        app = Krita.instance()
        parent = app.activeWindow().qwindow()
        if self.pending is not None:
            QMessageBox.information(parent, LABEL, "上一筆回程仍在處理中。")
            return
        try:
            doc = app.activeDocument()
            if doc is None or ANNOTATION not in doc.annotationTypes():
                raise ValueError("請先開啟 Phasyn 美術工作包或由其另存的 KRA。")
            data = doc.annotation(ANNOTATION)
            if data.size() > MAX_MANIFEST:
                raise ValueError("KRA 的工作包註記過大。")
            manifest = bytes(data)
            media = plates(manifest)
            roles = [r for r in ROLES if r in media]
            names = [ROLE_NAMES[r] for r in roles]
            name, ok = QInputDialog.getItem(parent, LABEL, "回程素材角色", names, 0, False)
            if not ok:
                return
            role = roles[names.index(name)]
            modes = ["目前圖層", "可見畫布"]
            if role == "mask":
                modes.append("目前選區")
            mode, ok = QInputDialog.getItem(parent, LABEL, "修訂來源", modes, 0, False)
            if not ok:
                return
            port, ok = QInputDialog.getInt(parent, LABEL, "送至本機 Studio 的連接埠", 8080, 1, 65535)
            if not ok:
                return
            png = _revision(doc, role, mode, media[role])
            self.pending = self.executor.submit(submit, port, role, manifest, png)
            QTimer.singleShot(100, lambda: self.finish(port))
        except ERRORS as error:
            QMessageBox.warning(parent, LABEL, str(error))

    def finish(self, port):
        future = self.pending
        if not future.done():
            QTimer.singleShot(100, lambda: self.finish(port))
            return
        self.pending = None
        window = Krita.instance().activeWindow()
        if window is None:
            return
        parent = window.qwindow()
        try:
            run_id = future.result()
        except ERRORS as error:
            QMessageBox.warning(parent, LABEL, str(error))
            return
        answer = QMessageBox.question(parent, LABEL, f"Studio 已接收回程 {run_id}。開啟執行紀錄以檢查並採用成果？")
        if answer == QMessageBox.StandardButton.Yes:
            QDesktopServices.openUrl(QUrl(f"http://127.0.0.1:{port}/records/runs/{run_id}"))
