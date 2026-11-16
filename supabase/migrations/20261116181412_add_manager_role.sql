alter table public.user_profiles
  drop constraint if exists user_profiles_role_check;

alter table public.user_profiles
  add constraint user_profiles_role_check
  check (role in ('master', 'manager', 'collaborator'));

create or replace function public.meudrive_can_access_all_files()
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
        and role in ('master', 'manager')
    );
$$;

revoke all on function public.meudrive_can_access_all_files() from public, anon;
grant execute on function public.meudrive_can_access_all_files() to authenticated, service_role;

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
        when lower(coalesce(new.email, '')) = 'jose_evilanio@hotmail.com' then 'master'
        when public.user_profiles.role = 'master' then 'master'
        else public.user_profiles.role
      end;

  return new;
end;
$$;

drop policy if exists "user_insert_meudrive_objects" on storage.objects;
drop policy if exists "user_select_meudrive_objects" on storage.objects;
drop policy if exists "user_update_meudrive_objects" on storage.objects;
drop policy if exists "user_delete_meudrive_objects" on storage.objects;

create policy "user_insert_meudrive_objects"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'MeuDriver'
  and (
    (select public.meudrive_can_access_all_files())
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
    (select public.meudrive_can_access_all_files())
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
    (select public.meudrive_can_access_all_files())
    or (storage.foldername(name))[1] = (select auth.uid()::text)
  )
)
with check (
  bucket_id = 'MeuDriver'
  and (
    (select public.meudrive_can_access_all_files())
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
    (select public.meudrive_can_access_all_files())
    or (storage.foldername(name))[1] = (select auth.uid()::text)
  )
);