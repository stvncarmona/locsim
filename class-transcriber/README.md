# Apuntes de Clase

Transcriptor de clases largas (2 h o más) que se ejecuta **entero en el navegador** con Whisper (Transformers.js). El audio no sale del equipo.

## Qué resuelve para clases largas
- **Archivos de 800 MB o más** (probado con MP4 de vídeo de 840 MB / 2 h 30 min y WAV de 838 MB): el archivo no se carga en memoria; se lee por rangos.
- **Decodificación en streaming** (Mediabunny + WebCodecs): no carga 2–3 h de audio en memoria; procesa bloques de ~2 min cortados en pausas.
- **Reanudable**: cada bloque se guarda en IndexedDB. Si se cierra la pestaña, se vuelve a elegir el mismo archivo y se pulsa «Continuar».
- **Grabación en directo** con el micrófono, guardada cada 10 s (sobrevive a un cierre inesperado).
- **WebGPU** si está disponible (varias veces más rápido que tiempo real); CPU (WASM multihilo) si no.
- Filtro de alucinaciones típicas de Whisper en silencios.
- Exporta TXT, Markdown (párrafos cada 5 min), SRT y VTT; búsqueda y reproductor sincronizado.

## Modelos
| Opción | Modelo | Uso |
|---|---|---|
| Rápido | `onnx-community/whisper-base` | Cualquier equipo |
| Equilibrado | `onnx-community/whisper-small` | Mejor precisión; lento sin GPU |
| Máxima calidad | `onnx-community/whisper-large-v3-turbo` | Solo WebGPU con fp16 |

## Ejecutar en local
Es estático, sin build:
```
npx serve class-transcriber
```

## Desplegar
Cualquier hosting estático. `vercel.json` añade COOP/COEP (`credentialless`) para habilitar WASM multihilo.
