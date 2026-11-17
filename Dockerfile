FROM python:3.11-slim

WORKDIR /app

# Les modèles Hugging Face sont stockés dans un dossier lisible/inscriptible par l'utilisateur du Space.
ENV HF_HOME=/app/hf-cache \
    PYTHONUNBUFFERED=1

COPY backend/requirements.txt ./requirements.txt
# Version CPU de PyTorch (beaucoup plus légère que la version GPU)
RUN pip install --no-cache-dir --extra-index-url https://download.pytorch.org/whl/cpu -r requirements.txt

# Pré-télécharge les deux modèles pendant le build : pas d'attente au premier appel.
RUN python -c "from transformers import AutoImageProcessor, AutoModelForImageClassification, AutoTokenizer, VitsModel; m='linkanjarad/mobilenet_v2_1.0_224-plant-disease-identification'; AutoImageProcessor.from_pretrained(m); AutoModelForImageClassification.from_pretrained(m); AutoTokenizer.from_pretrained('facebook/mms-tts-fon'); VitsModel.from_pretrained('facebook/mms-tts-fon')" \
    || echo "Pré-téléchargement ignoré : les modèles seront téléchargés au premier appel."

COPY backend ./backend
COPY frontend ./frontend
RUN chmod -R a+rwX /app

WORKDIR /app/backend

# Hugging Face Spaces attend le port 7860 ; Render/autres hôtes fournissent $PORT.
ENV PORT=7860
EXPOSE 7860

CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT}"]
