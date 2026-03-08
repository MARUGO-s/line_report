import json
import os
import shlex
import subprocess
import tempfile
from pathlib import Path

from fastapi import FastAPI, File, Header, HTTPException, UploadFile

app = FastAPI(title="line-wine-ndlocr-bridge", version="0.1.0")

OCR_BRIDGE_TOKEN = os.getenv("OCR_BRIDGE_TOKEN", "").strip()
NDLOCR_WORKDIR = os.getenv("NDLOCR_WORKDIR", "/opt/ndlocr-lite/src").strip()
NDLOCR_COMMAND = os.getenv("NDLOCR_COMMAND", "python3 ocr.py").strip()
NDLOCR_DEVICE = os.getenv("NDLOCR_DEVICE", "cpu").strip() or "cpu"
NDLOCR_TIMEOUT_SEC = max(5, int(os.getenv("NDLOCR_TIMEOUT_SEC", "60")))
MAX_UPLOAD_BYTES = max(1_000_000, int(os.getenv("MAX_UPLOAD_BYTES", str(10 * 1024 * 1024))))


SUPPORTED_EXTENSIONS = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/tiff": ".tif",
    "image/bmp": ".bmp"
}


def require_auth(authorization: str | None) -> None:
    if not OCR_BRIDGE_TOKEN:
        return

    header = (authorization or "").strip()
    if not header.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="missing bearer token")

    token = header.split(" ", 1)[1].strip()
    if token != OCR_BRIDGE_TOKEN:
        raise HTTPException(status_code=401, detail="invalid token")


def infer_suffix(upload: UploadFile) -> str:
    content_type = (upload.content_type or "").lower().strip()
    if content_type in SUPPORTED_EXTENSIONS:
        return SUPPORTED_EXTENSIONS[content_type]

    filename = (upload.filename or "").strip()
    ext = Path(filename).suffix.lower()
    if ext in {".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff", ".bmp", ".jp2"}:
        return ".jpg" if ext == ".jpeg" else ext

    return ".jpg"


def parse_confidence(payload: dict) -> float | None:
    values: list[float] = []
    contents = payload.get("contents")
    if isinstance(contents, list):
        for group in contents:
            if not isinstance(group, list):
                continue
            for row in group:
                if not isinstance(row, dict):
                    continue
                raw = row.get("confidence")
                try:
                    num = float(raw)
                except (TypeError, ValueError):
                    continue
                values.append(num)

    if not values:
        return None
    return round(sum(values) / len(values), 4)


def run_ndlocr(input_image: Path) -> dict:
    with tempfile.TemporaryDirectory(prefix="ndlocr-out-") as output_dir:
        output_path = Path(output_dir)
        command = [*shlex.split(NDLOCR_COMMAND), "--sourceimg", str(input_image), "--output", str(output_path), "--device", NDLOCR_DEVICE]

        try:
            result = subprocess.run(
                command,
                cwd=NDLOCR_WORKDIR,
                capture_output=True,
                text=True,
                timeout=NDLOCR_TIMEOUT_SEC,
                check=True
            )
        except subprocess.TimeoutExpired as exc:
            raise HTTPException(status_code=504, detail=f"ndlocr timed out after {NDLOCR_TIMEOUT_SEC}s") from exc
        except subprocess.CalledProcessError as exc:
            detail = (exc.stderr or exc.stdout or "ndlocr failed").strip()
            raise HTTPException(status_code=500, detail=f"ndlocr failed: {detail[:500]}") from exc

        stem = input_image.stem
        txt_path = output_path / f"{stem}.txt"
        json_path = output_path / f"{stem}.json"

        if not txt_path.exists():
            log_snippet = (result.stdout or "").strip()[-500:]
            raise HTTPException(status_code=500, detail=f"ndlocr output txt not found: {log_snippet}")

        text = txt_path.read_text(encoding="utf-8", errors="ignore").strip()
        if not text:
            return {
                "text": "",
                "confidence": None,
                "provider": "ndlocr-lite",
                "lines": 0
            }

        confidence = None
        lines = len([line for line in text.splitlines() if line.strip()])
        if json_path.exists():
            try:
                payload = json.loads(json_path.read_text(encoding="utf-8", errors="ignore"))
                confidence = parse_confidence(payload)
            except json.JSONDecodeError:
                confidence = None

        return {
            "text": text,
            "confidence": confidence,
            "provider": "ndlocr-lite",
            "lines": lines
        }


@app.get("/health")
def health() -> dict:
    return {
        "ok": True,
        "provider": "ndlocr-lite",
        "workdir": NDLOCR_WORKDIR,
        "timeoutSec": NDLOCR_TIMEOUT_SEC,
        "authRequired": bool(OCR_BRIDGE_TOKEN)
    }


@app.post("/ocr")
async def ocr(
    image: UploadFile = File(...),
    authorization: str | None = Header(default=None)
) -> dict:
    require_auth(authorization)

    file_bytes = await image.read()
    if not file_bytes:
        raise HTTPException(status_code=400, detail="image is empty")
    if len(file_bytes) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail=f"image is too large (max {MAX_UPLOAD_BYTES} bytes)")

    suffix = infer_suffix(image)
    with tempfile.TemporaryDirectory(prefix="ndlocr-input-") as input_dir:
        input_path = Path(input_dir) / f"upload{suffix}"
        input_path.write_bytes(file_bytes)
        result = run_ndlocr(input_path)
        return result
