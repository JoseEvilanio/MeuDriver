create table if not exists public.user_profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  role text not null default 'collaborator'
    check (role in ('master', 'collaborator')),
  created_at timestamptz not null default now()
);

create unique index if not exists user_profiles_email_lower_key
  on public.user_profiles (lower(email))
  where email is not null;

alter table public.user_profiles enable row level security;

revoke all on table public.user_profiles from public, anon, authenticated;
grant select on table public.user_profiles to authenticated;
grant all on table public.user_profiles to service_role;

create or replace function public.meudrive_is_master()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    lower(coalesce((select auth.jwt() ->> 'email'), '')) = 'jose_evilanio@hotmail.com'
    or exists (
      select 1
      from public.user_profiles
      where id = (select auth.uid())
        and role = 'master'
    );
$$;

revoke all on function public.meudrive_is_master() from public, anon;
grant execute on function public.meudrive_is_master() to authenticated, service_role;

create or replace function public.sync_meudrive_user_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.user_profiles (id, email, role)
  values (
    new.id,
    lower(new.email),
    case
      when lower(coalesce(new.email, '')) = 'jose_evilanio@hotmail.com' then 'master'
      else 'collaborator'
    end
  )
  on conflict (id) do update
  set email = excluded.email,
      role = case
        when public.user_profiles.role = 'master' or excluded.role = 'master' then 'master'
        else 'collaborator'
      end;

  return new;
end;
$$;

drop trigger if exists sync_meudrive_user_profile on auth.users;
create trigger sync_meudrive_user_profile
after insert or update of email on auth.users
for each row execute function public.sync_meudrive_user_profile();

insert into public.user_profiles (id, email, role)
select
  id,
  lower(email),
  case
    when lower(coalesce(email, '')) = 'jose_evilanio@hotmail.com' then 'master'
    else 'collaborator'
  end
from auth.users
on conflict (id) do update
set email = excluded.email,
    role = case
      when public.user_profiles.role = 'master' or excluded.role = 'master' then 'master'
      else 'collaborator'
    end;

drop policy if exists "user_profiles_select_self_or_master" on public.user_profiles;
create policy "user_profiles_select_self_or_master"
on public.user_profiles
for select
to authenticated
using ((select auth.uid()) = id or (select public.meudrive_is_master()));

drop policy if exists "user_insert_meudrive_objects" on storage.objects;
drop policy if exists "user_select_meudrive_objects" on storage.objects;
drop policy if exists "user_update_meudrive_objects" on storage.objects;
drop policy if exists "user_delete_meudrive_objects" on storage.objects;
drop policy if exists "authenticated_upload_to_meudrive" on storage.objects;

create policy "user_insert_meudrive_objects"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'MeuDriver'
  and (
    (select public.meudrive_is_master())
    or (storage.foldername(name))[1] = (select auth.uid()::text)
  )
);

create policy "user_select_meudrive_objects"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'MeuDriver'
  and (
    (select public.meudrive_is_master())
    or (storage.foldername(name))[1] = (select auth.uid()::text)
  )
);

create policy "user_update_meudrive_objects"
on storage.objects
for update
to authenticated
using (
  bucket_id = 'MeuDriver'
  and (
    (select public.meudrive_is_master())
    or (storage.foldername(name))[1] = (select auth.uid()::text)
  )
)
with check (
  bucket_id = 'MeuDriver'
  and (
    (select public.meudrive_is_master())
    or (storage.foldername(name))[1] = (select auth.uid()::text)
  )
);

create policy "user_delete_meudrive_objects"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'MeuDriver'
  and (
    (select public.meudrive_is_master())
    or (storage.foldername(name))[1] = (select auth.uid()::text)
  )
);
