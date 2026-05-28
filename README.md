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
$env:VIDEO_PROCESSING_WORKER_CONCURRENCY = "1"
$env:VIDEO_HLS_ENCODER = "h264_nvenc"
npm run video:process-worker
```

Esse modo pega jobs `queued`, baixa o original do R2, gera HLS/poster/storyboard localmente e devolve tudo para o R2/Supabase.
Jobs antigos em `processing` nao sao reabertos automaticamente; use `VIDEO_PROCESSING_REQUEUE_STALE=1` somente quando quiser recuperar uma fila travada de proposito.

Para registrar como tarefa do Windows:

```powershell
powershell -ExecutionPolicy Bypass -File C:\ci-vimeo-agent\scripts\register-video-processing-task-windows.ps1 -Gpu
```

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
