#!/usr/bin/env python3
import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path


TRACKS = {
    "pt-BR": {"label": "Português", "file": "captions.pt-BR.vtt"},
    "en": {"label": "English", "file": "captions.en.vtt"},
    "es": {"label": "Español", "file": "captions.es.vtt"},
}


def emit(event_type, **payload):
    print(json.dumps({"type": event_type, **payload}, ensure_ascii=False), flush=True)


def emit_progress(stage, progress):
    emit("progress", stage=stage, progress=max(0, min(100, int(progress))))


def vtt_timestamp(seconds):
    seconds = max(0.0, float(seconds or 0.0))
    millis = int(round((seconds - int(seconds)) * 1000))
    total = int(seconds)
    hours = total // 3600
    minutes = (total % 3600) // 60
    secs = total % 60
    return f"{hours:02d}:{minutes:02d}:{secs:02d}.{millis:03d}"


def clean_caption_text(text):
    text = re.sub(r"\s+", " ", (text or "").strip())
    return text.replace("-->", "->")


def env_bool(name, default):
    value = os.environ.get(name)
    if value is None or value.strip() == "":
        return default
    return value.strip().lower() in {"1", "true", "yes", "sim", "on"}


def env_int(name, default):
    value = os.environ.get(name)
    if value is None or value.strip() == "":
        return default
    try:
        return int(value)
    except ValueError:
        return default


def write_vtt(path, cues):
    lines = ["WEBVTT", ""]
    for index, cue in enumerate(cues, start=1):
        text = clean_caption_text(cue["text"])
        if not text:
            continue
        lines.append(str(index))
        lines.append(f"{vtt_timestamp(cue['start'])} --> {vtt_timestamp(cue['end'])}")
        lines.append(text)
        lines.append("")
    Path(path).write_text("\n".join(lines), encoding="utf-8")


def prepare_audio_source(source_path, output_dir):
    audio_path = Path(output_dir) / "caption-audio.wav"
    emit_progress("extraindo audio para legendas", 1)
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            source_path,
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "pcm_s16le",
            str(audio_path),
        ],
        check=True,
    )
    return str(audio_path)


def transcribe(source_path, model_name, device, compute_type, language, vad_filter):
    from faster_whisper import WhisperModel

    batch_size = max(1, env_int("VIDEO_CAPTIONS_TRANSCRIPTION_BATCH_SIZE", 16))
    attempts = []
    requested_device = (device or "auto").strip().lower()
    if requested_device == "auto":
        attempts.append(("cuda", compute_type or "float16"))
        if (compute_type or "").strip().lower() != "int8":
            attempts.append(("cuda", "int8"))
        attempts.append(("cpu", "int8"))
    elif requested_device == "cuda":
        attempts.append(("cuda", compute_type or "float16"))
        if (compute_type or "").strip().lower() != "int8":
            attempts.append(("cuda", "int8"))
        attempts.append(("cpu", "int8"))
    else:
        attempts.append(("cpu", compute_type or "int8"))

    last_error = None
    for attempt_device, attempt_compute in attempts:
        try:
            emit_progress(f"carregando Whisper {model_name} ({attempt_device})", 1)
            model = WhisperModel(model_name, device=attempt_device, compute_type=attempt_compute)
            emit_progress(f"transcrevendo legenda pt-BR ({attempt_device})", 5)
            transcriber = model
            transcribe_kwargs = {}
            if attempt_device == "cuda" and batch_size > 1:
                try:
                    from faster_whisper import BatchedInferencePipeline

                    transcriber = BatchedInferencePipeline(model=model)
                    transcribe_kwargs["batch_size"] = batch_size
                    transcribe_kwargs["without_timestamps"] = False
                    emit_progress(f"transcrevendo legenda pt-BR ({attempt_device}, batch {batch_size})", 5)
                except Exception as exc:  # noqa: BLE001
                    print(f"[captions] batch indisponivel, usando modo simples: {exc}", file=sys.stderr, flush=True)

            segments, info = transcriber.transcribe(
                source_path,
                language=language,
                task="transcribe",
                beam_size=5,
                vad_filter=vad_filter,
                word_timestamps=False,
                **transcribe_kwargs,
            )
            duration = float(getattr(info, "duration", 0.0) or 0.0)
            cues = []
            for segment in segments:
                start = float(getattr(segment, "start", 0.0) or 0.0)
                end = float(getattr(segment, "end", start) or start)
                text = clean_caption_text(getattr(segment, "text", ""))
                if not text:
                    continue
                cues.append({"start": start, "end": max(end, start + 0.25), "text": text})
                if duration > 0:
                    emit_progress("transcrevendo legenda pt-BR", 5 + (end / duration) * 45)
            return cues, {"device": attempt_device, "compute_type": attempt_compute, "duration": duration}
        except Exception as exc:  # noqa: BLE001
            last_error = exc
            print(f"[captions] falha com {attempt_device}/{attempt_compute}: {exc}", file=sys.stderr, flush=True)

    raise RuntimeError(f"Whisper nao conseguiu transcrever o video: {last_error}")


def load_translation(model_name, device):
    import torch
    from transformers import AutoModelForSeq2SeqLM, AutoTokenizer

    tokenizer = AutoTokenizer.from_pretrained(model_name)
    model = AutoModelForSeq2SeqLM.from_pretrained(model_name)
    use_cuda = (device or "cpu").strip().lower() == "cuda" and torch.cuda.is_available()
    if use_cuda:
        model = model.to("cuda")
    model.eval()
    return tokenizer, model, "cuda" if use_cuda else "cpu"


def translate_texts(texts, model_name, device, stage, progress_start, progress_end):
    import torch

    if not texts:
        return []

    emit_progress(f"carregando traducao {model_name}", progress_start)
    tokenizer, model, actual_device = load_translation(model_name, device)
    translated = []
    batch_size = max(1, int(os.environ.get("VIDEO_CAPTIONS_TRANSLATION_BATCH_SIZE", "8")))

    for start in range(0, len(texts), batch_size):
        batch = texts[start:start + batch_size]
        encoded = tokenizer(batch, return_tensors="pt", padding=True, truncation=True, max_length=384)
        if actual_device == "cuda":
            encoded = {key: value.to("cuda") for key, value in encoded.items()}
        with torch.no_grad():
            output = model.generate(**encoded, max_new_tokens=256, num_beams=4)
        translated.extend(tokenizer.batch_decode(output, skip_special_tokens=True))
        emit_progress(stage, progress_start + ((start + len(batch)) / len(texts)) * (progress_end - progress_start))

    return [clean_caption_text(text) for text in translated]


def clone_cues_with_text(cues, texts):
    return [
        {"start": cue["start"], "end": cue["end"], "text": text}
        for cue, text in zip(cues, texts)
    ]


def warmup(args):
    from faster_whisper import WhisperModel

    emit_progress("baixando/carregando Whisper", 1)
    WhisperModel(args.model, device="cpu", compute_type="int8")

    if args.translate:
        emit_progress("baixando/carregando traducao pt-en", 45)
        load_translation(args.pt_en_model, "cpu")
        if args.pt_es_model:
            emit_progress("baixando/carregando traducao pt-es", 70)
            load_translation(args.pt_es_model, "cpu")
        else:
            emit_progress("baixando/carregando traducao en-es", 70)
            load_translation(args.en_es_model, "cpu")

    emit("result", warmup=True)


def main():
    parser = argparse.ArgumentParser(description="Gera legendas VTT PT-BR/EN/ES para videos do Hub.")
    parser.add_argument("--source", required=False)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--result-json", required=True)
    parser.add_argument("--model", default=os.environ.get("VIDEO_CAPTIONS_MODEL", "large-v3"))
    parser.add_argument("--device", default=os.environ.get("VIDEO_CAPTIONS_DEVICE", "cuda"))
    parser.add_argument("--compute-type", default=os.environ.get("VIDEO_CAPTIONS_COMPUTE_TYPE", "float16"))
    parser.add_argument("--language", default=os.environ.get("VIDEO_CAPTIONS_SOURCE_LANGUAGE", "pt"))
    parser.add_argument("--vad-filter", action=argparse.BooleanOptionalAction, default=env_bool("VIDEO_CAPTIONS_VAD_FILTER", False))
    parser.add_argument("--translate", action=argparse.BooleanOptionalAction, default=os.environ.get("VIDEO_CAPTIONS_TRANSLATE", "1") != "0")
    parser.add_argument("--translation-device", default=os.environ.get("VIDEO_CAPTIONS_TRANSLATION_DEVICE", "cpu"))
    parser.add_argument("--pt-en-model", default=os.environ.get("VIDEO_CAPTIONS_PT_EN_MODEL", "Helsinki-NLP/opus-mt-mul-en"))
    parser.add_argument("--pt-es-model", default=os.environ.get("VIDEO_CAPTIONS_PT_ES_MODEL", ""))
    parser.add_argument("--en-es-model", default=os.environ.get("VIDEO_CAPTIONS_EN_ES_MODEL", "Helsinki-NLP/opus-mt-en-es"))
    parser.add_argument("--warmup", action="store_true")
    args = parser.parse_args()

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    if args.warmup:
        warmup(args)
        return

    if not args.source:
        raise SystemExit("--source e obrigatorio fora do warmup.")

    source_path = prepare_audio_source(str(Path(args.source)), output_dir)
    pt_path = output_dir / TRACKS["pt-BR"]["file"]
    en_path = output_dir / TRACKS["en"]["file"]
    es_path = output_dir / TRACKS["es"]["file"]

    cues_pt, transcription_info = transcribe(source_path, args.model, args.device, args.compute_type, args.language, args.vad_filter)
    if not cues_pt:
        raise RuntimeError("Whisper nao retornou segmentos de legenda.")

    write_vtt(pt_path, cues_pt)
    tracks = [{
        "language": "pt-BR",
        "label": TRACKS["pt-BR"]["label"],
        "path": str(pt_path),
        "default": True,
        "source": f"faster-whisper:{args.model}",
    }]

    if args.translate:
        pt_texts = [cue["text"] for cue in cues_pt]
        en_texts = translate_texts(
            pt_texts,
            args.pt_en_model,
            args.translation_device,
            "traduzindo legenda para ingles",
            55,
            72,
        )
        write_vtt(en_path, clone_cues_with_text(cues_pt, en_texts))
        tracks.append({
            "language": "en",
            "label": TRACKS["en"]["label"],
            "path": str(en_path),
            "default": False,
            "source": args.pt_en_model,
        })

        if args.pt_es_model:
            es_texts = translate_texts(
                pt_texts,
                args.pt_es_model,
                args.translation_device,
                "traduzindo legenda para espanhol",
                74,
                92,
            )
            es_source = args.pt_es_model
        else:
            es_texts = translate_texts(
                en_texts,
                args.en_es_model,
                args.translation_device,
                "traduzindo legenda para espanhol",
                74,
                92,
            )
            es_source = f"{args.pt_en_model} + {args.en_es_model}"
        write_vtt(es_path, clone_cues_with_text(cues_pt, es_texts))
        tracks.append({
            "language": "es",
            "label": TRACKS["es"]["label"],
            "path": str(es_path),
            "default": False,
            "source": es_source,
        })

    result = {
        "tracks": tracks,
        "segments": len(cues_pt),
        "transcription": transcription_info,
    }
    Path(args.result_json).write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    emit_progress("legendas prontas", 100)
    emit("result", **result)


if __name__ == "__main__":
    main()
