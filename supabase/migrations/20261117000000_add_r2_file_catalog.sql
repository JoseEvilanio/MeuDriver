create table if not exists public.drive_files (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  folder_id uuid,
  original_name text not null,
  original_path text not null,
  storage_key text not null unique,
  bucket_name text not null,
  mime_type text not null default 'application/octet-stream',
  file_extension text,
  file_size bigint not null check (file_size >= 0),
  etag text,
  storage_provider text not null default 'cloudflare_r2'
    check (storage_provider in ('cloudflare_r2', 'supabase')),
  upload_status text not null default 'uploading'
    check (upload_status in ('uploading', 'completed', 'failed', 'cancelled')),
  file_fingerprint text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create unique index if not exists drive_files_user_path_active_key
  on public.drive_files (user_id, original_path)
  where deleted_at is null;

create index if not exists drive_files_user_updated_idx
  on public.drive_files (user_id, updated_at desc)
  where deleted_at is null and upload_status = 'completed';

create index if not exists drive_files_path_search_idx
  on public.drive_files (user_id, lower(original_name))
  where deleted_at is null and upload_status = 'completed';

create table if not exists public.drive_uploads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  file_id uuid not null references public.drive_files (id) on delete cascade,
  upload_id text,
  storage_key text not null,
  total_size bigint not null check (total_size >= 0),
  part_size bigint not null check (part_size > 0),
  mime_type text not null default 'application/octet-stream',
  file_fingerprint text not null,
  completed_parts integer[] not null default '{}',
  status text not null default 'uploading'
    check (status in ('uploading', 'completed', 'cancelled', 'failed')),
  expires_at timestamptz not null default (now() + interval '30 days'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists drive_uploads_user_status_idx
  on public.drive_uploads (user_id, status, expires_at);

create index if not exists drive_uploads_file_id_idx
  on public.drive_uploads (file_id);

alter table public.drive_files enable row level security;
alter table public.drive_uploads enable row level security;

revoke all on table public.drive_files, public.drive_uploads from public, anon, authenticated;
grant select on table public.drive_files to authenticated;
grant all on table public.drive_files, public.drive_uploads to service_role;

drop policy if exists "drive_files_select_authorized" on public.drive_files;
create policy "drive_files_select_authorized"
on public.drive_files
for select
to authenticated
using (
  deleted_at is null
  and (
    user_id = (select auth.uid())
    or (select public.meudrive_can_access_all_files())
  )
);

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'drive_files'
  ) then
    alter publication supabase_realtime add table public.drive_files;
  end if;
end;
$$;
