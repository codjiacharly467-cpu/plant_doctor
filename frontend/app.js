// Plant Doctor — frontend logic
// Talks to the same-origin FastAPI backend: POST /api/predict, POST /api/advice

const API_BASE = ""; // same origin as the static files (backend serves both)

const $ = (id) => document.getElementById(id);

const els = {
  dropzone: $("dropzone"),
  dropzoneEmpty: $("dropzone-empty"),
  fileInput: $("file-input"),
  previewImg: $("preview-img"),
  btnAnalyze: $("btn-analyze"),
  btnResetUpload: $("btn-reset-upload"),
  uploadError: $("upload-error"),

  stepUpload: $("step-upload"),
  stepLoading: $("step-loading"),
  stepResult: $("step-result"),
  stepAdvice: $("step-advice"),

  resultImg: $("result-img"),
  resultPlant: $("result-plant"),
  resultDisease: $("result-disease"),
  resultDiseaseLabel: $("result-disease-label"),
  resultDiseaseEmoji: $("result-disease-emoji"),
  resultConfidence: $("result-confidence"),
  confidenceBarFill: $("confidence-bar-fill"),
  lowConfidenceWarning: $("low-confidence-warning"),
  altPredictions: $("alt-predictions"),
  altPredictionsList: $("alt-predictions-list"),

  btnAdvice: $("btn-advice"),
  btnRestart: $("btn-restart"),
  btnRestart2: $("btn-restart-2"),

  adviceSubtitle: $("advice-subtitle"),
  adviceLoading: $("advice-loading"),
  adviceContent: $("advice-content"),
  adviceList: $("advice-list"),
  adviceNote: $("advice-note"),
  btnTranslate: $("btn-translate"),
  btnListen: $("btn-listen"),
  translateNote: $("translate-note"),
};

let selectedFile = null;
let lastPrediction = null;

function showStep(step) {
  [els.stepUpload, els.stepLoading, els.stepResult, els.stepAdvice].forEach((s) => s.classList.add("hidden"));
  step.classList.remove("hidden");
  step.scrollIntoView({ behavior: "smooth", block: "start" });
}

function resetAll() {
  selectedFile = null;
  lastPrediction = null;
  els.fileInput.value = "";
  els.previewImg.classList.add("hidden");
  els.dropzoneEmpty.classList.remove("hidden");
  els.btnAnalyze.disabled = true;
  els.btnResetUpload.classList.add("hidden");
  els.uploadError.classList.add("hidden");
  showStep(els.stepUpload);
}

// --- File selection ---

els.dropzone.addEventListener("click", () => els.fileInput.click());
els.dropzone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") els.fileInput.click();
});

["dragover", "dragenter"].forEach((evt) =>
  els.dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    els.dropzone.style.borderColor = "var(--leaf)";
  })
);
["dragleave", "drop"].forEach((evt) =>
  els.dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    els.dropzone.style.borderColor = "";
  })
);
els.dropzone.addEventListener("drop", (e) => {
  const file = e.dataTransfer.files[0];
  if (file) handleFile(file);
});

els.fileInput.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (file) handleFile(file);
});

function handleFile(file) {
  if (!file.type.startsWith("image/")) {
    showUploadError("Ce fichier n'est pas une image. Choisissez un JPEG, PNG ou WEBP.");
    return;
  }
  selectedFile = file;
  const url = URL.createObjectURL(file);
  els.previewImg.src = url;
  els.previewImg.classList.remove("hidden");
  els.dropzoneEmpty.classList.add("hidden");
  els.btnAnalyze.disabled = false;
  els.btnResetUpload.classList.remove("hidden");
  els.uploadError.classList.add("hidden");
}

els.btnResetUpload.addEventListener("click", (e) => {
  e.stopPropagation();
  resetAll();
});

function showUploadError(msg) {
  els.uploadError.textContent = msg;
  els.uploadError.classList.remove("hidden");
}

// --- Analyze ---

els.btnAnalyze.addEventListener("click", async () => {
  if (!selectedFile) return;
  showStep(els.stepLoading);
  $("loading-text").textContent = "Analyse de l'image en cours…";

  const formData = new FormData();
  formData.append("file", selectedFile);

  try {
    const res = await fetch(`${API_BASE}/api/predict`, { method: "POST", body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Erreur d'analyse");
    lastPrediction = data;
    renderResult(data);
  } catch (err) {
    showStep(els.stepUpload);
    showUploadError("Échec de l'analyse : " + err.message + " — vérifiez que le serveur backend tourne bien.");
  }
});

function renderResult(data) {
  els.resultImg.src = els.previewImg.src;

  els.resultPlant.textContent = data.plant || "Inconnue";

  if (data.healthy) {
    els.resultDiseaseEmoji.textContent = "✅";
    els.resultDiseaseLabel.innerHTML = `État : <strong id="result-disease">Plante saine</strong>`;
  } else {
    els.resultDiseaseEmoji.textContent = "⚠️";
    els.resultDiseaseLabel.innerHTML = `Maladie détectée : <strong id="result-disease">${data.disease}</strong>`;
  }

  els.resultConfidence.textContent = `${data.confidence}%`;
  const fill = els.confidenceBarFill;
  fill.style.width = `${data.confidence}%`;
  fill.className = "confidence-bar-fill";
  if (data.confidence < 60) fill.classList.add("low");
  else if (data.confidence < 80) fill.classList.add("mid");

  els.lowConfidenceWarning.classList.toggle("hidden", !data.low_confidence);

  if (data.all_predictions && data.all_predictions.length > 1) {
    els.altPredictionsList.innerHTML = "";
    data.all_predictions.slice(1).forEach((p) => {
      const li = document.createElement("li");
      const label = p.healthy ? `${p.plant} — sain` : `${p.plant} — ${p.disease}`;
      li.textContent = `${label} (${p.confidence}%)`;
      els.altPredictionsList.appendChild(li);
    });
    els.altPredictions.classList.remove("hidden");
  } else {
    els.altPredictions.classList.add("hidden");
  }

  els.btnAdvice.classList.remove("hidden"); // always offer advice (healthy => care tips)

  showStep(els.stepResult);
}

// --- Conseils (Gemini) ---

els.btnAdvice.addEventListener("click", async () => {
  if (!lastPrediction) return;
  showStep(els.stepAdvice);
  els.adviceSubtitle.textContent = lastPrediction.healthy
    ? `Conseils d'entretien pour : ${lastPrediction.plant}`
    : `Conseils Gemini pour : ${lastPrediction.plant} — ${lastPrediction.disease}`;
  els.adviceContent.classList.add("hidden");
  els.adviceNote.classList.add("hidden");
  els.adviceLoading.classList.remove("hidden");

  try {
    const res = await fetch(`${API_BASE}/api/advice`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        plant: lastPrediction.plant,
        disease: lastPrediction.disease,
        healthy: lastPrediction.healthy,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Erreur lors de la génération des conseils");
    renderAdvice(data);
  } catch (err) {
    els.adviceLoading.classList.add("hidden");
    els.adviceNote.textContent = "Impossible de récupérer les conseils : " + err.message;
    els.adviceNote.classList.remove("hidden");
  }
});

let lastAdvice = null;      // { summary, recommendations } en français
let fonTexts = null;        // traduction en fongbé (même ordre : résumé puis recommandations)
let showingFon = false;
let audioEl = null;         // lecteur audio en cours
let fonAudioUrl = null;     // audio déjà généré pour la traduction affichée

function stopAudio() {
  if (audioEl) { audioEl.pause(); audioEl = null; }
  els.btnListen.textContent = "🔊 Écouter en fongbé";
}

function drawAdvice(summary, recs) {
  els.adviceList.innerHTML = "";
  if (summary) {
    const p = document.createElement("li");
    p.textContent = summary;
    p.className = "summary";
    els.adviceList.appendChild(p);
  }
  recs.forEach((rec) => {
    const li = document.createElement("li");
    li.textContent = rec;
    els.adviceList.appendChild(li);
  });
}

function renderAdvice(data) {
  els.adviceLoading.classList.add("hidden");

  if (data.note) {
    els.adviceNote.textContent = data.note;
    els.adviceNote.classList.remove("hidden");
  }

  if (data.recommendations && data.recommendations.length > 0) {
    lastAdvice = { summary: data.summary || "", recommendations: data.recommendations };
    fonTexts = null;
    showingFon = false;
    stopAudio();
    fonAudioUrl = null;
    els.btnListen.classList.add("hidden");
    els.btnTranslate.textContent = "Traduire en fongbé";
    els.translateNote.classList.add("hidden");
    drawAdvice(lastAdvice.summary, lastAdvice.recommendations);
    els.adviceContent.classList.remove("hidden");
  }
}

// --- Traduction en fongbé ---

els.btnTranslate.addEventListener("click", async () => {
  if (!lastAdvice) return;

  // Retour au français
  if (showingFon) {
    drawAdvice(lastAdvice.summary, lastAdvice.recommendations);
    showingFon = false;
    stopAudio();
    els.btnListen.classList.add("hidden");
    els.btnTranslate.textContent = "Traduire en fongbé";
    els.translateNote.classList.add("hidden");
    return;
  }

  // Déjà traduit : on réaffiche sans rappeler l'API
  if (fonTexts) {
    showFon();
    return;
  }

  els.btnTranslate.disabled = true;
  els.btnTranslate.textContent = "Traduction en cours…";
  els.translateNote.classList.add("hidden");

  const texts = [lastAdvice.summary, ...lastAdvice.recommendations].filter(Boolean);
  try {
    const res = await fetch(`${API_BASE}/api/translate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ texts }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Erreur de traduction");
    if (!data.translations || data.translations.length !== texts.length) {
      throw new Error(data.note || "Traduction indisponible pour le moment.");
    }
    fonTexts = data.translations;
    showFon();
  } catch (err) {
    els.btnTranslate.textContent = "Traduire en fongbé";
    els.translateNote.textContent = err.message;
    els.translateNote.classList.remove("hidden");
  } finally {
    els.btnTranslate.disabled = false;
  }
});

els.btnListen.addEventListener("click", async () => {
  if (!fonTexts) return;

  if (audioEl) { stopAudio(); return; }   // 2e clic = arrêter

  els.btnListen.disabled = true;
  els.btnListen.textContent = "Chargement de la voix…";
  try {
    if (!fonAudioUrl) {
      const res = await fetch(`${API_BASE}/api/tts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ texts: fonTexts }),
      });
      if (!res.ok) {
        let msg = "Lecture audio indisponible.";
        try { msg = (await res.json()).detail || msg; } catch (_) {}
        throw new Error(msg);
      }
      const missing = decodeURIComponent(res.headers.get("X-Missing-Chars") || "");
      if (missing) {
        els.translateNote.textContent =
          `Traduction automatique : faites-la relire par un locuteur. La voix ne sait pas lire ces caractères et les saute : ${missing}`;
      }
      fonAudioUrl = URL.createObjectURL(await res.blob());
    }
    audioEl = new Audio(fonAudioUrl);
    audioEl.addEventListener("ended", stopAudio);
    await audioEl.play();
    els.btnListen.textContent = "⏹ Arrêter";
  } catch (err) {
    stopAudio();
    els.translateNote.textContent = err.message;
    els.translateNote.classList.remove("hidden");
  } finally {
    els.btnListen.disabled = false;
  }
});

function showFon() {
  const hasSummary = Boolean(lastAdvice.summary);
  drawAdvice(hasSummary ? fonTexts[0] : "", hasSummary ? fonTexts.slice(1) : fonTexts);
  showingFon = true;
  els.btnTranslate.textContent = "Voir en français";
  els.btnListen.classList.remove("hidden");
  els.translateNote.textContent = "Traduction automatique en fongbé : faites-la relire par un locuteur avant de l'utiliser.";
  els.translateNote.classList.remove("hidden");
}

els.btnRestart.addEventListener("click", resetAll);
els.btnRestart2.addEventListener("click", resetAll);
