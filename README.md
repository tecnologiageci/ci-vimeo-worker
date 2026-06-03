# CI Vimeo Worker

Worker independente para migrar videos do Vimeo para Cloudflare R2.

Ele baixa o MP4 do Vimeo, sobe o MP4 original para o R2, converte para HLS, sobe o HLS para o R2, registra no Supabase/Hub e limpa os arquivos temporarios.

## Windows

Abra o PowerShell como administrador e rode:

```powershell
irm https://raw.githubusercontent.com/tecnologiageci/ci-vimeo-worker/main/scripts/bootstrap-windows.ps1 -OutFile "$env:TEMP\ci-vimeo-bootstrap.ps1"; powershell -ExecutionPolicy Bypass -File "$env:TEMP\ci-vimeo-bootstrap.ps1" -WorkerName PC-RTX-01
```

Esse comando tambem instala o ZeroTier e entra na rede `3b19b3a716c84da5`. Depois autorize o novo dispositivo no painel do ZeroTier se ele aparecer como pendente.

Para pular ZeroTier:

```powershell
irm https://raw.githubusercontent.com/tecnologiageci/ci-vimeo-worker/main/scripts/bootstrap-windows.ps1 -OutFile "$env:TEMP\ci-vimeo-bootstrap.ps1"; powershell -ExecutionPolicy Bypass -File "$env:TEMP\ci-vimeo-bootstrap.ps1" -WorkerName PC-RTX-01 -SkipZeroTier
```

Ou, se ja clonou o repositorio:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup-vimeo-worker-windows.ps1 -WorkerName PC-RTX-01 -InstallPath C:\ci-vimeo-runner
```

Depois copie as credenciais para `C:\ci-vimeo-runner\.env.local`.

Teste seco, sem gravar nada:

```powershell
powershell -ExecutionPolicy Bypass -File C:\ci-vimeo-runner\start-vimeo-worker.ps1 -Limit 1
```

Rodar real com GPU NVIDIA:

```powershell
powershell -ExecutionPolicy Bypass -File C:\ci-vimeo-runner\start-vimeo-worker.ps1 -Execute -Notify -Gpu
```

## VPS com Docker

```bash
cp .env.example .env
docker compose build
docker compose up -d
./run-worker.sh vps-worker
```

## Painel e fila central

O modo recomendado para varios computadores e pelo agent:

```powershell
powershell -ExecutionPolicy Bypass -File C:\ci-vimeo-runner\start-vimeo-agent.ps1
```

O agent conversa com o Hub em `/api/videos/workers/agent`, recebe comandos do painel `/videos/workers` e pega tarefas da fila central. Assim cada computador so processa videos reservados para ele, sem duplicar trabalho.

Pelo painel da para iniciar, pausar, retomar e parar cada computador. Pausar termina o lote atual e nao pega novos videos. Parar interrompe o processo atual e libera as tarefas para outro worker.

## Processamento HLS dos uploads do Hub

Uploads feitos pelo painel do Hub entram na tabela `video_processing_jobs`. Para deixar a VPS apenas como painel/orquestradora, rode este worker no computador secundario:

```powershell
$env:VIDEO_PROCESSING_WORKER_NAME = "PC-LUIZ-HLS"
$env:VIDEO_PROCESSING_WORKER_DISPLAY_NAME = "Luiz RTX"
$env:VIDEO_PROCESSING_WORKER_IP = "10.13.136.117"
$env:VIDEO_PROCESSING_QUEUE_NAME = "uploads"
$env:VIDEO_PROCESSING_QUEUE_STATUS = "queued"
$env:VIDEO_PROCESSING_QUEUE_LABEL = "uploads novos HLS"
$env:VIDEO_PROCESSING_WORKER_CONCURRENCY = "1"
$env:VIDEO_HLS_ENCODER = "h264_nvenc"
npm run video:process-worker
```

Esse modo pega jobs da fila `uploads`, baixa o original do R2, gera HLS/poster/storyboard localmente e devolve tudo para o R2/Supabase.
Jobs antigos ficam separados na fila `legacy`, com outro worker. Quando o video antigo ja tem HLS pronto e o job vem como `captions`, o worker baixa o original e gera apenas as legendas/traducoes, sem refazer o HLS. Por padrao, o worker `legacy` aguarda enquanto houver upload novo em `queued` ou `processing`, para nao disputar GPU com videos enviados agora. O worker reenfileira automaticamente jobs antigos que ficarem presos em `processing` sem atualizacao e reinicia o processo quando passar muito tempo sem progresso.

### Legendas automaticas

Nos uploads novos (`QueueName=uploads`) e nos jobs antigos de legenda (`QueueName=legacy`, `job_type=captions`), o worker gera legendas WebVTT:

- `pt-BR`: transcricao local com `faster-whisper`/Whisper.
- `en`: traducao local com OPUS-MT/Helsinki-NLP.
- `es`: traducao local via OPUS-MT, mantendo os mesmos timestamps.

Antes de chamar o Whisper, o worker extrai o audio do video para `caption-audio.wav` em mono/16 kHz. Assim a IA le apenas o arquivo de audio, reduzindo I/O e evitando analisar o container MP4/HLS durante a transcricao.

Por padrao, o job de HLS nao espera a legenda terminar. Quando o HLS fica pronto, o worker marca o video como pronto e cria um job separado `captions` na fila `legacy`, evitando que um travamento de Whisper segure uploads novos. Para voltar ao comportamento antigo, defina `VIDEO_CAPTIONS_INLINE=1`.

Prepare o ambiente de IA no Windows:

```powershell
powershell -ExecutionPolicy Bypass -File C:\ci-vimeo-agent\scripts\setup-video-captioning-windows.ps1 -DownloadModels
```

Variaveis uteis:

- `VIDEO_CAPTIONS_ENABLED`: `1` para ligar, `0` para desligar.
- `VIDEO_CAPTIONS_MODEL`: modelo Whisper, padrao `large-v3`.
- `VIDEO_CAPTIONS_DEVICE`: `cuda`, `cpu` ou `auto`; padrao `cuda` com fallback para CPU.
- `VIDEO_CAPTIONS_COMPUTE_TYPE`: padrao `float16`, usando FP16 direto na GPU. Se falhar por VRAM, o script tenta fallback automatico para `int8`.
- `VIDEO_CAPTIONS_INLINE`: `1` para gerar legenda dentro do job HLS; padrao `0`, gerando job separado de legenda.
- `VIDEO_CAPTIONS_QUEUE_NAME`: fila dos jobs de legenda criados apos HLS; padrao `legacy`.
- `VIDEO_CAPTIONS_QUEUE_STATUS`: status dos jobs de legenda criados apos HLS; padrao `queued_legacy`.
- `VIDEO_CAPTIONS_VAD_FILTER`: `1` para filtro VAD do Whisper; padrao `0` para evitar espera longa antes do primeiro progresso em aulas grandes.
- `VIDEO_CAPTIONS_TRANSLATE`: `1` para gerar ingles/espanhol, `0` para so PT-BR.

Para registrar como tarefa do Windows sem depender de CMD aberto:

```powershell
powershell -ExecutionPolicy Bypass -File C:\ci-vimeo-agent\scripts\register-video-processing-task-windows.ps1 -QueueName "uploads" -QueueStatus "queued" -StaleMinutes 45 -JobStallMinutes 90 -Gpu
```

Para registrar a fila antiga de legendas/reprocessamento:

```powershell
powershell -ExecutionPolicy Bypass -File C:\ci-vimeo-agent\scripts\register-video-processing-task-windows.ps1 -TaskName "CI Video Processing Luiz Old" -WorkerName "PC-LUIZ-HLS-OLD" -QueueName "legacy" -QueueStatus "queued_legacy" -QueueLabel "fila antiga legendas" -StaleMinutes 45 -JobStallMinutes 90 -Gpu
```

Essas tarefas usam `supervise-video-processing-worker-windows.ps1`, ficam ocultas no Agendador de Tarefas, sobem no logon/startup e reiniciam o worker sempre que o Node/ffmpeg cair. O proprio worker tambem manda heartbeat periodico durante o processamento; se ficar sem progresso pelo limite configurado, ele devolve o job para a fila e encerra para o supervisor subir de novo.

Perfis comuns:

- PC forte RTX: `videoConcurrency=8`, `hlsConcurrency=3`, `uploadConcurrency=4`.
- GTX medio: `videoConcurrency=2`, `hlsConcurrency=1`, `uploadConcurrency=2`.
- CPU: `videoConcurrency=1`, `hlsConcurrency=1`, `uploadConcurrency=1`.

## Variaveis principais

- `VIMEO_MIGRATION_VIDEO_CONCURRENCY`: quantos videos baixar/subir em paralelo.
- `VIMEO_MIGRATION_HLS_CONCURRENCY`: quantas conversoes HLS em paralelo.
- `VIDEO_HLS_ENCODER`: `libx264` para CPU ou `h264_nvenc` para NVIDIA.
- `VIMEO_MIGRATION_FOLDER_URI`: limita a uma pasta do Vimeo.
- `VIMEO_MIGRATION_LIMIT`: limita a quantidade de videos.
- `VIMEO_MIGRATION_NOTIFY`: envia notificacoes pela Juliana/Evolution.

Nunca commit `.env` ou `.env.local`.
