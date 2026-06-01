export type VideoAssetStatus = 'draft' | 'uploading' | 'uploaded' | 'processing' | 'ready' | 'failed'
export type VideoJobStatus = 'queued' | 'processing' | 'completed' | 'failed'

export interface VideoAsset {
  id: string
  title: string
  description: string | null
  status: VideoAssetStatus
  source_key: string | null
  source_bucket: string | null
  source_size_bytes: number | null
  source_content_type: string | null
  hls_prefix: string | null
  hls_manifest_key: string | null
  poster_key: string | null
  storyboard_key?: string | null
  storyboard_interval_seconds?: number | null
  storyboard_columns?: number | null
  storyboard_rows?: number | null
  storyboard_frame_width?: number | null
  storyboard_frame_height?: number | null
  storyboard_frame_count?: number | null
  captions_key: string | null
  caption_tracks?: Array<{
    language: string
    label: string
    key: string
    default?: boolean
    source?: string | null
    generated_at?: string | null
  }> | null
  duration_seconds: number | null
  width: number | null
  height: number | null
  last_error: string | null
  folder_id: string | null
  source_file_name: string | null
  source_fingerprint: string | null
  created_at: string
  updated_at: string
  processed_at: string | null
}

export interface VideoEmbedSettings {
  id: 'global'
  allowed_domains: string[]
  player_brand_name: string
  player_primary_color: string
  player_logo_url: string | null
}

export interface R2ObjectSummary {
  key: string
  size: number
  lastModified: string | null
}
