---
title: Plant Doctor
emoji: 🌿
colorFrom: green
colorTo: yellow
sdk: docker
app_port: 7860
pinned: false
---

# 🌿 Plant Doctor — diagnostic IA de maladies des plantes

Prototype de hackathon (budget 0 €) : photo de feuille → diagnostic IA → conseils de traitement → traduction en fongbé → lecture à voix haute.

```
📷 Photo → 🧠 Modèle de vision → 🌿 Plante / Maladie → 🎯 Confiance
        → 💡 Conseils (Gemini) → 🌍 Traduction en fongbé (Gemini) → 🔊 Lecture audio (Meta MMS-TTS)
```

## Ce qui est utilisé

| Composant | Choix | Détails |
|---|---|---|
| Modèle de vision | [`linkanjarad/mobilenet_v2_1.0_224-plant-disease-identification`](https://huggingface.co/linkanjarad/mobilenet_v2_1.0_224-plant-disease-identification) | MobileNetV2 fine-tuné sur PlantVillage, 38 classes (maladies et plantes saines), chargé via `transformers`. Léger (~14 Mo), rapide sur CPU. |
| Conseils | API Gemini (palier gratuit) | Résumé et recommandations en français, sortie JSON structurée, cache en mémoire. Modèles `gemini-3.5-flash`, puis `gemini-3.1-flash-lite` et `gemini-3.5-flash-lite` en repli ; 2 nouveaux essais automatiques si un modèle est surchargé (503). |
| Traduction | API Gemini (palier gratuit) | Français → fongbé. Modèles `gemini-3.5-flash-lite`, puis `gemini-3.1-flash-lite` et `gemini-3.5-flash` en repli. |
| Voix | [`facebook/mms-tts-fon`](https://huggingface.co/facebook/mms-tts-fon) (Meta MMS-TTS) | Synthèse vocale en fon (VITS, ~150 Mo, téléchargé au premier clic sur « Écouter »). |
| Backend | FastAPI + Uvicorn | Sert l'API et le frontend statique (un seul serveur). |
| Frontend | HTML / CSS / JS vanilla | Aucun build, fonctionne sur mobile. |

## Ambiance sonore et effets

- Les **bruitages** (clics, succès, erreur) et la **musique d'ambiance** sont générés par le navigateur (Web Audio) : aucun fichier audio, donc aucun droit d'auteur à gérer.
- Les navigateurs interdisent le son avant un premier clic : la musique démarre au premier toucher.
- Deux boutons en haut à droite coupent la musique (🎵) et les bruitages avec vibrations (🔔). Le choix est mémorisé.
- La **vibration** ne fonctionne que sur les téléphones Android (Chrome, Firefox), pas sur iPhone ni sur ordinateur.
- Pendant la lecture audio en fongbé, la musique baisse automatiquement.
- Les animations sont désactivées pour les personnes qui ont réduit les mouvements dans leur système.
- Volumes réglables en haut de `frontend/effects.js` (`MUSIC_LEVEL`, `SFX_LEVEL`).

## Limites à connaître

- **Conseils générés par IA** : ils peuvent contenir des erreurs. À confirmer auprès d'un technicien agricole avant tout traitement.
- **Fongbé** : la traduction est automatique et le fon est une langue peu représentée dans les données des modèles. Faites relire le résultat par un locuteur. La voix MMS ignore les caractères absents de son vocabulaire (l'application affiche la liste des caractères sautés).
- **Modèle de vision** : PlantVillage est un jeu de données « de laboratoire » (fond uni, lumière contrôlée). Sur une photo de terrain, la confiance peut baisser ; un avertissement s'affiche sous 60 %.
- **Licences** : la voix `facebook/mms-tts-fon` est sous **CC-BY-NC 4.0 (usage non commercial)**. Pour le modèle de vision, la page Hugging Face indique `license: other` : vérifiez-la avant toute utilisation commerciale.

## Configuration

Aucune clé n'est écrite dans le code. Tout passe par des variables d'environnement.

| Variable | Rôle | Obligatoire |
|---|---|---|
| `GEMINI_API_KEY` | Clé gratuite créée sur [aistudio.google.com](https://aistudio.google.com) | Oui (conseils et traduction) |
| `GEMINI_MODEL` | Modèles des conseils, séparés par des virgules (le premier est essayé en premier) | Non |
| `GEMINI_TRANSLATE_MODEL` | Modèles de traduction, séparés par des virgules | Non |
| `TTS_MODEL` | Modèle vocal (défaut : `facebook/mms-tts-fon`) | Non |
| `TTS_ENABLED` | `0` désactive la lecture audio (hébergeur à faible mémoire). Défaut : `1` | Non |
| `PORT` | Port d'écoute dans Docker (défaut 7860) | Non |

## Installation locale

Depuis la racine du dépôt (le dossier qui contient `backend` et `frontend`) :

### Linux / macOS

```bash
python3 -m venv venv
source venv/bin/activate
pip install -r backend/requirements.txt
```

### Windows (PowerShell)

```powershell
py -m venv venv
.\venv\Scripts\python.exe -m pip install -r backend\requirements.txt
```

L'utilisation directe de `venv\Scripts\python.exe` évite d'avoir à activer l'environnement virtuel. Ainsi, PowerShell ne bloque pas les commandes si sa politique d'exécution interdit les scripts `.ps1`.

## Lancer le site

### Linux / macOS

```bash
source venv/bin/activate
cd backend
export GEMINI_API_KEY="votre_cle_gemini"
uvicorn main:app --port 8000
```

### Windows (PowerShell)

Depuis la racine du dépôt, définissez votre clé Gemini pour la session PowerShell en cours, puis démarrez le serveur :

```powershell
$env:GEMINI_API_KEY = "votre_cle_gemini"
cd backend
..\venv\Scripts\python.exe -m uvicorn main:app --port 8000
```

Remplacez `votre_cle_gemini` par votre clé. Ne la partagez pas et ne l'ajoutez pas au dépôt. Cette variable disparaît quand vous fermez PowerShell ; il faudra la définir à nouveau dans chaque nouvelle session. Pour arrêter le serveur, faites `Ctrl+C` dans PowerShell.

Ouvrez **http://localhost:8000**. Le frontend et l'API sont servis par le même serveur.

Il faut lancer `uvicorn` depuis le dossier `backend` : le frontend est cherché dans `../frontend`.

Premiers appels (internet requis une seule fois, puis cache dans `~/.cache/huggingface`) :
- `/api/predict` télécharge le modèle de vision ;
- `/api/tts` télécharge la voix fon au premier clic sur « Écouter en fongbé ».

## API

| Route | Rôle |
|---|---|
| `POST /api/predict` | Image → plante, maladie, confiance, autres hypothèses |
| `POST /api/advice` | Plante + maladie → résumé et recommandations (Gemini) |
| `POST /api/translate` | Liste de textes français → fongbé (Gemini) |
| `POST /api/tts` | Liste de textes fon → fichier audio WAV (MMS-TTS) |
| `GET /api/gemini-models` | Diagnostic : modèles Gemini utilisables avec votre clé |
| `GET /api/health` | Vérification que le serveur répond |

## Test du parcours complet (avant la démo)

1. Ouvrir le site (fenêtre privée si l'ancien affichage persiste).
2. Importer une photo de feuille, puis cliquer sur « Analyser une plante ».
3. Vérifier la plante, la maladie (ou « saine ») et le pourcentage de confiance.
4. Cliquer sur « Obtenir des conseils » : un résumé et des recommandations s'affichent.
5. Cliquer sur « Traduire en fongbé » : le texte passe en fon.
6. Cliquer sur « 🔊 Écouter en fongbé » : l'audio se lance (le premier clic est plus long).
7. Cliquer sur « Voir en français », puis sur « Nouvelle analyse » avec une autre photo.

Si les conseils ou la traduction échouent, le message affiché donne le code d'erreur de Google par modèle. Cas fréquents : `GEMINI_API_KEY` absente, quota gratuit dépassé (attendre une minute), modèle surchargé (503, le repli prend le relais).

## Déploiement gratuit

### Hugging Face Spaces (recommandé)

Les lignes `---` en tête de ce README sont la configuration du Space (SDK Docker, port 7860) : ne les supprimez pas.

1. Créer un Space avec le SDK **Docker** (modèle « Blank ») et y envoyer ce dossier (avec le `Dockerfile` à la racine).
2. Dans **Settings → Variables and secrets**, ajouter `GEMINI_API_KEY` comme **secret**.
3. Le Space se construit seul (plusieurs minutes : les modèles sont téléchargés pendant le build) et expose le site sur `https://<user>-<space>.hf.space`.

### Render.com

1. Créer un Web Service relié au dépôt Git ; le `Dockerfile` est détecté automatiquement.
2. Choisir le plan **Free**, puis ajouter dans les variables d'environnement : `GEMINI_API_KEY` (votre clé) et `TTS_ENABLED=0`.
3. Le plan gratuit n'a que 512 Mo de RAM : la voix (MMS) est désactivée pour économiser la mémoire. Le service s'endort après 15 minutes d'inactivité (environ une minute pour se réveiller) : ouvrez le site avant la démo.

## Arborescence

```
plant-doctor/
├── Dockerfile
├── README.md
├── backend/
│   ├── main.py            # API FastAPI (predict, advice, translate, tts)
│   └── requirements.txt
└── frontend/
    ├── index.html
    ├── style.css
    ├── app.js
    ├── effects.js         # bruitages, vibrations, musique d'ambiance, lucioles
    ├── hero.avif          # photo d'accueil (champ au lever du soleil)
    └── hero.jpg           # même photo, version de secours
```
