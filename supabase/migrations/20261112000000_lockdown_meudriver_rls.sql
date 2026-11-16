drop policy if exists "authenticated_upload_to_meudriver" on storage.objects;
drop policy if exists "user_insert_meudriver_objects" on storage.objects;
drop policy if exists "user_select_meudriver_objects" on storage.objects;
drop policy if exists "user_update_meudriver_objects" on storage.objects;

create policy "user_insert_meudriver_objects"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'MeuDriver'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
);

create policy "user_select_meudriver_objects"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'MeuDriver'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
);

create policy "user_update_meudriver_objects"
on storage.objects
for update
to authenticated
using (
  bucket_id = 'MeuDriver'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
)
with check (
  bucket_id = 'MeuDriver'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
);
