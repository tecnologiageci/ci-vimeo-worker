# CI Vimeo Worker

Worker independente para migrar videos do Vimeo para Cloudflare R2.

Ele baixa o MP4 do Vimeo, sobe o MP4 original para o R2, converte para HLS, sobe o HLS para o R2, registra no Supabase/Hub e limpa os arquivos temporarios.

## Windows

Abra o PowerShell como administrador e rode:

```powershell
irm https://raw.githubusercontent.com/tecnologiageci/ci-vimeo-worker/main/scripts/bootstrap-windows.ps1 -OutFile "$env:TEMP\ci-vimeo-bootstrap.ps1"; powershell -ExecutionPolicy Bypass -File "$env:TEMP\ci-vimeo-bootstrap.ps1" -WorkerName PC-RTX-01
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

## Variaveis principais

- `VIMEO_MIGRATION_VIDEO_CONCURRENCY`: quantos videos baixar/subir em paralelo.
- `VIMEO_MIGRATION_HLS_CONCURRENCY`: quantas conversoes HLS em paralelo.
- `VIDEO_HLS_ENCODER`: `libx264` para CPU ou `h264_nvenc` para NVIDIA.
- `VIMEO_MIGRATION_FOLDER_URI`: limita a uma pasta do Vimeo.
- `VIMEO_MIGRATION_LIMIT`: limita a quantidade de videos.
- `VIMEO_MIGRATION_NOTIFY`: envia notificacoes pela Juliana/Evolution.

Nunca commit `.env` ou `.env.local`.
