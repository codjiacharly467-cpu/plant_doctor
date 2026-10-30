"""
Plant Doctor — backend API
===========================

Two endpoints:
  POST /api/predict  -> image in, {plant, disease, healthy, confidence, all_predictions} out
  POST /api/advice    -> disease name in, {summary, recommendations, sources} out (RAG over live web search)

Model: linkanjarad/mobilenet_v2_1.0_224-plant-disease-identification
  - Fine-tuned MobileNetV2 (google/mobilenet_v2_1.0_224 backbone) on the PlantVillage /
    "New Plant Diseases Dataset" (38 classes: 26 diseases + 12 healthy states).
  - Reported eval accuracy: 95.4% (see model card).
  - Loaded through `transformers` (AutoImageProcessor + AutoModelForImageClassification),
    weights are pulled from the Hugging Face Hub the first time the server starts
    (cached locally afterwards) — this REQUIRES outbound internet access once, at
    server startup / first request. No API key or payment is needed, the repo is public.

"Conseils" feature (Gemini):
  - /api/advice calls the Gemini API (free tier) with the GEMINI_API_KEY env var.
  - Gemini is asked for a strict JSON answer (summary + recommendations), in French.
  - Answers are cached in memory per (plant, disease) to save the free quota.
  - If the key is missing or the quota is exhausted, the API says so plainly.
"""

import io
import os
import json
import wave
import hashlib
import logging
import threading
from urllib.parse import quote
from typing import Dict, Tuple

import torch
from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel
from PIL import Image
import requests
from transformers import AutoImageProcessor, AutoModelForImageClassification, AutoTokenizer, VitsModel

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("plant-doctor")

MODEL_NAME = "linkanjarad/mobilenet_v2_1.0_224-plant-disease-identification"

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
# gemini-2.5-* a été arrêté le 16/10/2026 (d'où l'erreur 404) -> on utilise la génération 3.x,
# avec repli automatique sur le modèle suivant si l'un renvoie 404/429.
GEMINI_MODELS = [m.strip() for m in os.getenv(
    "GEMINI_MODEL", "gemini-3.5-flash,gemini-3.1-flash-lite").split(",") if m.strip()]
GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"

app = FastAPI(title="Plant Doctor API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

_model = None
_processor = None
_device = "cuda" if torch.cuda.is_available() else "cpu"


def get_model():
    """Lazy-load the model on first request so the server boots instantly."""
    global _model, _processor
    if _model is None:
        log.info("Loading %s ...", MODEL_NAME)
        _processor = AutoImageProcessor.from_pretrained(MODEL_NAME)
        _model = AutoModelForImageClassification.from_pretrained(MODEL_NAME)
        _model.to(_device)
        _model.eval()
        log.info("Model loaded on %s. %d classes.", _device, len(_model.config.id2label))
    return _model, _processor


def parse_label(raw_label: str):
    """Gère 'Tomato___Late_blight', 'Grape with Black Rot' et 'Healthy Apple'."""
    label = raw_label.replace("_", " ").strip()
    if "___" in raw_label:
        plant, _, dis = raw_label.partition("___")
        plant = plant.replace("_", " ").replace("(", "").replace(")", "").strip()
        dis = dis.replace("_", " ").strip()
    elif " with " in label:
        plant, _, dis = label.partition(" with ")
    elif label.lower().startswith("healthy "):
        plant, dis = label[8:], "healthy"
    elif label.lower().endswith(" healthy"):
        plant, dis = label[:-8], "healthy"
    else:
        return label, "Unknown", False
    is_healthy = dis.lower() == "healthy"
    return plant.strip(), ("Healthy" if is_healthy else dis.strip().title()), is_healthy


@app.post("/api/predict")
async def predict(file: UploadFile = File(...)):
    if file.content_type not in ("image/jpeg", "image/png", "image/jpg", "image/webp"):
        raise HTTPException(400, "Merci d'envoyer une image (JPEG, PNG ou WEBP).")

    raw = await file.read()
    if len(raw) == 0:
        raise HTTPException(400, "Fichier image vide.")

    try:
        image = Image.open(io.BytesIO(raw)).convert("RGB")
    except Exception:
        raise HTTPException(400, "Impossible de lire cette image. Essayez un autre fichier.")

    try:
        model, processor = get_model()
    except Exception as e:
        log.exception("Model load failed")
        raise HTTPException(
            503,
            "Le modèle IA n'a pas pu être chargé (pas d'accès internet au premier "
            "démarrage pour télécharger les poids, ou dépendance manquante). "
            f"Détail: {e}",
        )

    inputs = processor(images=image, return_tensors="pt").to(_device)
    with torch.no_grad():
        logits = model(**inputs).logits
        probs = torch.nn.functional.softmax(logits, dim=-1)[0]

    top5 = torch.topk(probs, k=min(5, probs.shape[0]))
    all_predictions = []
    for score, idx in zip(top5.values.tolist(), top5.indices.tolist()):
        raw_label = model.config.id2label[idx]
        plant, disease, is_healthy = parse_label(raw_label)
        all_predictions.append({
            "plant": plant,
            "disease": disease,
            "healthy": is_healthy,
            "confidence": round(score * 100, 2),
        })

    best = all_predictions[0]
    return {
        "plant": best["plant"],
        "disease": best["disease"],
        "healthy": best["healthy"],
        "confidence": best["confidence"],
        "low_confidence": best["confidence"] < 60.0,
        "all_predictions": all_predictions,
        "model": MODEL_NAME,
    }


# ---------------------------------------------------------------------------
# "Conseils" — generated by Gemini
# ---------------------------------------------------------------------------

_advice_cache: Dict[Tuple[str, str], dict] = {}

ADVICE_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "summary": {"type": "STRING"},
        "recommendations": {"type": "ARRAY", "items": {"type": "STRING"}},
    },
    "required": ["summary", "recommendations"],
}


class AdviceRequest(BaseModel):
    plant: str
    disease: str
    healthy: bool = False


def build_prompt(req: AdviceRequest) -> str:
    if req.healthy:
        task = (
            f"La plante « {req.plant} » a été jugée saine par un modèle de vision. "
            "Donne des conseils d'entretien préventifs pour la garder en bonne santé."
        )
    else:
        task = (
            f"Un modèle de vision a détecté la maladie « {req.disease} » sur la plante « {req.plant} ». "
            "Explique brièvement la maladie, puis donne des conseils concrets : "
            "traitement, gestes culturaux, prévention. Privilégie des solutions accessibles "
            "à un petit agriculteur d'Afrique de l'Ouest."
        )
    return (
        "Tu es un agronome expert. Réponds en français, de façon claire et pratique.\n"
        f"{task}\n"
        "Format : un résumé de 2 phrases maximum (summary) et 5 à 7 recommandations courtes "
        "(une phrase chacune). Si un produit chimique est cité, rappelle de suivre l'étiquette."
    )


@app.post("/api/advice")
async def advice(req: AdviceRequest):
    key = (req.plant.lower(), req.disease.lower())
    if key in _advice_cache:
        return _advice_cache[key]

    if not GEMINI_API_KEY:
        return {
            "recommendations": [], "sources": [],
            "note": "Clé Gemini absente : définissez la variable d'environnement GEMINI_API_KEY.",
        }

    payload = {
        "contents": [{"parts": [{"text": build_prompt(req)}]}],
        "generationConfig": {
            "temperature": 0.3,
            "responseMimeType": "application/json",
            "responseSchema": ADVICE_SCHEMA,
        },
    }
    data, errors, quota = None, [], False
    for model in GEMINI_MODELS:
        try:
            resp = requests.post(
                GEMINI_URL.format(model=model),
                headers={"x-goog-api-key": GEMINI_API_KEY, "Content-Type": "application/json"},
                json=payload, timeout=30,
            )
            if resp.status_code != 200:
                try:
                    msg = resp.json().get("error", {}).get("message", resp.text)
                except Exception:
                    msg = resp.text
                errors.append(f"{model} -> HTTP {resp.status_code}: {msg[:200]}")
                log.warning(errors[-1])
                continue
            text = resp.json()["candidates"][0]["content"]["parts"][0]["text"]
            data = json.loads(text)
            log.info("Advice generated with %s", model)
            break
        except Exception as e:
            log.exception("Gemini call failed (%s)", model)
            errors.append(f"{model} -> {e}")
    if data is None:
        return {"recommendations": [], "sources": [],
                "note": "Gemini indisponible. " + " | ".join(errors)}

    result = {
        "plant": req.plant,
        "disease": req.disease,
        "summary": data.get("summary", ""),
        "recommendations": data.get("recommendations", [])[:8],
        "sources": [],
        "note": "Conseils générés par IA (Gemini) : à confirmer auprès d'un technicien agricole.",
    }
    _advice_cache[key] = result
    return result


# ---------------------------------------------------------------------------
# Traduction en fongbé — Gemini (modèle léger)
# ---------------------------------------------------------------------------
# NB : les modèles récents (3.5 flash-lite, 3.6 flash...) n'acceptent plus
# temperature/top_p/top_k : on ne les envoie donc pas ici.
TRANSLATE_MODELS = [m.strip() for m in os.getenv(
    "GEMINI_TRANSLATE_MODEL", "gemini-3.5-flash-lite,gemini-3.1-flash-lite").split(",") if m.strip()]

TRANSLATE_SCHEMA = {
    "type": "OBJECT",
    "properties": {"translations": {"type": "ARRAY", "items": {"type": "STRING"}}},
    "required": ["translations"],
}

_translate_cache: Dict[str, list] = {}


class TranslateRequest(BaseModel):
    texts: list[str]


@app.post("/api/translate")
async def translate_fon(req: TranslateRequest):
    texts = [t.strip() for t in req.texts if t and t.strip()][:12]
    if not texts:
        return {"translations": [], "note": "Rien à traduire."}
    cache_key = json.dumps(texts, ensure_ascii=False)
    if cache_key in _translate_cache:
        return {"translations": _translate_cache[cache_key]}
    if not GEMINI_API_KEY:
        return {"translations": [], "note": "Clé Gemini absente : définissez GEMINI_API_KEY."}

    prompt = (
        "Traduis chacun des textes suivants du français vers le fongbé (fon, Bénin). "
        "Utilise l'orthographe standard du fon avec ses caractères (ɖ, ɛ, ɔ, ŋ, ã, etc.). "
        "Si un terme technique (nom de maladie, produit) n'a pas d'équivalent courant en fon, "
        "garde-le en français. Garde exactement le même nombre d'éléments et le même ordre. "
        "Réponds uniquement en JSON.\n\nTextes :\n" + json.dumps(texts, ensure_ascii=False)
    )
    payload = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {"responseMimeType": "application/json", "responseSchema": TRANSLATE_SCHEMA},
    }
    errors = []
    for model in TRANSLATE_MODELS:
        try:
            resp = requests.post(
                GEMINI_URL.format(model=model),
                headers={"x-goog-api-key": GEMINI_API_KEY, "Content-Type": "application/json"},
                json=payload, timeout=40,
            )
            if resp.status_code != 200:
                try:
                    msg = resp.json().get("error", {}).get("message", resp.text)
                except Exception:
                    msg = resp.text
                errors.append(f"{model} -> HTTP {resp.status_code}: {msg[:200]}")
                log.warning(errors[-1])
                continue
            out = json.loads(resp.json()["candidates"][0]["content"]["parts"][0]["text"])["translations"]
            if len(out) != len(texts):
                errors.append(f"{model} -> nombre d'éléments inattendu")
                continue
            log.info("Translation (fon) done with %s", model)
            _translate_cache[cache_key] = out
            return {"translations": out}
        except Exception as e:
            log.exception("Translate failed (%s)", model)
            errors.append(f"{model} -> {e}")
    return {"translations": [], "note": "Traduction indisponible. " + " | ".join(errors)}


# ---------------------------------------------------------------------------
# Lecture audio en fongbé — Meta MMS-TTS (facebook/mms-tts-fon)
# ---------------------------------------------------------------------------
# Modèle VITS léger (~145 Mo, téléchargé une seule fois depuis Hugging Face).
# Licence CC-BY-NC 4.0 : usage non commercial.
TTS_MODEL_NAME = os.getenv("TTS_MODEL", "facebook/mms-tts-fon")
_tts = {"model": None, "tok": None}
_tts_lock = threading.Lock()
_tts_cache: Dict[str, bytes] = {}


def get_tts():
    with _tts_lock:
        if _tts["model"] is None:
            log.info("Loading TTS model %s ...", TTS_MODEL_NAME)
            _tts["tok"] = AutoTokenizer.from_pretrained(TTS_MODEL_NAME)
            _tts["model"] = VitsModel.from_pretrained(TTS_MODEL_NAME).eval()
            log.info("TTS model loaded (%s Hz).", _tts["model"].config.sampling_rate)
    return _tts["model"], _tts["tok"]


class TTSRequest(BaseModel):
    texts: list[str]


@app.post("/api/tts")
def tts_fon(req: TTSRequest):
    import numpy as np

    texts = [t.strip()[:600] for t in req.texts if t and t.strip()][:12]
    if not texts:
        raise HTTPException(status_code=400, detail="Aucun texte à lire.")

    key = hashlib.sha1(json.dumps(texts, ensure_ascii=False).encode("utf-8")).hexdigest()
    try:
        model, tok = get_tts()
        vocab = tok.get_vocab()
        missing = sorted({c for t in texts for c in t.lower() if not c.isspace() and c not in vocab})

        if key not in _tts_cache:
            sr = model.config.sampling_rate
            pause = np.zeros(int(sr * 0.45), dtype=np.float32)
            chunks = []
            for t in texts:
                inputs = tok(t, return_tensors="pt")
                if inputs["input_ids"].shape[1] == 0:
                    continue
                torch.manual_seed(555)  # voix reproductible
                with torch.no_grad():
                    wav = model(**inputs).waveform[0].cpu().numpy().astype(np.float32)
                chunks += [wav, pause]
            if not chunks:
                raise HTTPException(status_code=422, detail="Le texte ne contient aucun caractère lisible par la voix.")
            audio = np.clip(np.concatenate(chunks), -1.0, 1.0)
            buf = io.BytesIO()
            with wave.open(buf, "wb") as w:
                w.setnchannels(1)
                w.setsampwidth(2)
                w.setframerate(sr)
                w.writeframes((audio * 32767).astype(np.int16).tobytes())
            if len(_tts_cache) > 20:
                _tts_cache.clear()
            _tts_cache[key] = buf.getvalue()
    except HTTPException:
        raise
    except Exception as e:
        log.exception("TTS failed")
        raise HTTPException(status_code=500, detail=f"Lecture audio indisponible : {e}")

    headers = {"X-Missing-Chars": quote("".join(missing))} if missing else {}
    return Response(content=_tts_cache[key], media_type="audio/wav", headers=headers)


@app.get("/api/gemini-models")
async def gemini_models():
    """Diagnostic : liste les modèles utilisables avec TA clé."""
    if not GEMINI_API_KEY:
        return {"error": "GEMINI_API_KEY absente"}
    r = requests.get("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200",
                     headers={"x-goog-api-key": GEMINI_API_KEY}, timeout=20)
    if r.status_code != 200:
        return {"status": r.status_code, "body": r.text[:300]}
    return {"models": [m["name"].replace("models/", "") for m in r.json().get("models", [])
                       if "generateContent" in m.get("supportedGenerationMethods", [])]}


@app.get("/api/health")
async def health():
    return {"status": "ok", "device": _device, "model_loaded": _model is not None}


# ---------------------------------------------------------------------------
# Serve the frontend (static files) — single-origin deployment, no CORS pain.
# ---------------------------------------------------------------------------
app.mount("/", StaticFiles(directory="../frontend", html=True), name="frontend")
