# Integração Cloudflare R2 - descontinuada no app

O frontend do MeuDrive usa exclusivamente Supabase Storage. Não há controles, listagem, upload, download, pré-visualização, edição ou exclusão de arquivos do Cloudflare R2.

Esta integração foi removida do app a pedido do usuário. Objetos e recursos remotos existentes não foram apagados nem alterados. A migration de catálogo e a Edge Function `cloudflare-storage` também foram preservadas no projeto Supabase; o frontend não as invoca. Consequentemente, arquivos armazenados no R2 não aparecem no MeuDrive.

Este documento substitui a especificação anterior da integração. Ele é mantido somente como registro da descontinuação e do estado preservado dos recursos remotos.
